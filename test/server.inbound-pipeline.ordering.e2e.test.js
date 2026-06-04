// Inbound-pipeline ordering — the regression behind "message they sent never
// arrived after I logged back in" + "group members shows only 1 entry".
//
// On login/reconnect, InboxCatchupService drains every buffered deposit. The
// old code re-emitted each on the bus fire-and-forget (bus.emit cannot await an
// async handler), so N deposits' apply-chains ran CONCURRENTLY. A peer's group
// MESSAGE then reached the membership gate (ServerEventService) BEFORE that
// peer's member.join committed ensureMembership — and the fail-closed gate
// DROPPED the message permanently (the relay withdraws on drain, so it's gone,
// not merely late). The same race left the joiner missing from the roster.
//
// The fix: a single serialized InboundDepositPipeline processes deposits ONE AT
// A TIME, IN ORDER, awaiting each to full completion. A member.join is applied
// before any message that depends on it. These tests drive the REAL pipeline +
// REAL ServerEventService/ServerGroupsService + the REAL membership gate; only
// the decrypt step is stubbed (the bug is ordering, not crypto). See memory
// feedback_inbound_deposit_pipeline_must_be_awaited_calls.

import test from "node:test";
import assert from "node:assert/strict";

import { ChatServerApp } from "../src/server/app/ChatServerApp.js";
import { InboundDepositPipeline } from "../src/server/runtime/InboundDepositPipeline.js";
import { GROUP_OP_KIND } from "../src/records/payloads/GroupOpPayloadV1.js";
import { MESSAGE_KIND } from "../src/records/payloads/ChatMessagePayloadV1.js";
import { makeSealDispatch } from "./support/sealDispatchDouble.js";

class TestKVStore {
  constructor() { this._data = new Map(); }
  async get(key) { return this._data.get(key); }
  async set(key, value) { this._data.set(key, value); }
  async delete(key) { this._data.delete(key); }
  async keys(prefix) {
    const out = [];
    for (const k of this._data.keys()) if (k.startsWith(prefix)) out.push(k);
    return out;
  }
}
class TestStorageProvider {
  constructor() { this._stores = new Map(); }
  getKeyValueStore(name) {
    if (!this._stores.has(name)) this._stores.set(name, new TestKVStore());
    return this._stores.get(name);
  }
}

const FAKE_KEYS = {
  publicKeyB64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  privateKeyB64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
};

const INVITER = "rez:acct:alice";
const JOINER = "rez:acct:bob";
const GROUP_ID = "grp_pipeline";
const INVITE_ID = "plinv_pipeline";

// Inviter (Alice) chat-server with the group already created + Alice as admin,
// and a peerLinks double that authorizes Bob's join (the invite-ledger checks
// are exercised elsewhere; here we isolate the ordering behaviour).
async function setupInviterServer() {
  const inviteRecord = {
    envelope: { inviteId: INVITE_ID, kind: "group", groupId: GROUP_ID, creatorAccountId: INVITER, title: "Pipe" },
    signatureB64: "sig",
  };
  const sdk = {
    getIdentity: () => ({ localInboxId: "inbox:alice" }),
    mailbox: { deposit: async () => ({ eventId: "evt-x" }) },
    ...makeSealDispatch({ onSend: () => {} }),
    peerLinks: { getPeerLink: async () => null },
  };
  const peerLinks = {
    ownerAccountId: INVITER,
    getStoredInviteEnvelope: async (_owner, id) => (id === INVITE_ID ? inviteRecord : null),
    authorizeInviteJoin: async () => ({ authorized: true, reason: "CONSUMED" }),
  };
  let now = 5000;
  const app = new ChatServerApp({
    identity: { ...FAKE_KEYS, accountId: INVITER, deviceId: "dev:alice" },
    uplinks: ["ws://localhost:9999"],
    storageProvider: new TestStorageProvider(),
    ownerAccountId: INVITER,
    clock: () => (now += 1),
  });
  app.bus.runtime.sdk = sdk;
  app.bus.runtime.peerLinks = peerLinks;
  await app.bus.services.threads.ensureGroupThread({ groupId: GROUP_ID, title: "Pipe", createdAtMs: 4000 });
  await app.bus.stores.groupStore.ensureMembership({
    ownerAccountId: INVITER, groupId: GROUP_ID, accountId: INVITER, role: "admin",
  });
  await app.bus.services.events.start();
  return app;
}

// A decrypted-deposit double: the inner plaintext rides on the frame; the stub
// "decrypts" by returning it as a user message (exactly the shape the real
// ServerPeerLinkProtocolService.processDeposit returns). The frame's own
// ciphertext is marked e2ee so the pipeline's plaintext pass (events.process-
// Deposit) skips it — mirroring production (no double-apply).
function makeStubPeerLinkProtocol() {
  return {
    async processDeposit(frame) {
      const body = frame && frame.body ? frame.body : {};
      if (!body.__innerB64) return null;
      return {
        userMessage: {
          eventId: body.eventId,
          mailboxId: body.mailboxId,
          plaintextB64: body.__innerB64,
          senderAccountId: body.senderAccountId,
        },
      };
    },
  };
}

function frameFor({ eventId, inner, senderAccountId }) {
  const innerB64 = Buffer.from(JSON.stringify(inner)).toString("base64");
  return {
    body: {
      eventId,
      mailboxId: "inbox:alice",
      // e2ee-marked so events.processDeposit (the plaintext pass) skips it.
      ciphertextB64: Buffer.from(JSON.stringify({ e2ee: 1 })).toString("base64"),
      senderAccountId,
      __innerB64: innerB64,
    },
  };
}

function joinInner() {
  return {
    kind: GROUP_OP_KIND,
    op: "member.join",
    groupId: GROUP_ID,
    accountId: JOINER,
    inviteId: INVITE_ID,
    displayName: "Bob",
    actedAtMs: 6000,
    groupOpId: "gop_join_pipe",
  };
}
function messageInner(threadId) {
  return {
    kind: MESSAGE_KIND,
    threadId,
    messageId: "msg_from_bob_1",
    senderAccountId: JOINER,
    text: "hello after I joined",
  };
}

async function listGroupMessages(app, threadId) {
  const page = await app.bus.stores.threadStore.listMessages({ threadId, limit: 50 });
  return page && Array.isArray(page.items) ? page.items : [];
}

test("serialized pipeline: member.join buffered before a group message → joiner is a member AND the message survives", async () => {
  const app = await setupInviterServer();
  const threadId = app.bus.services.threads.groupThreadId(GROUP_ID);
  const pipeline = new InboundDepositPipeline({
    peerLinkProtocol: makeStubPeerLinkProtocol(),
    events: app.bus.services.events,
  });

  // Two buffered deposits drained in deposit order: Bob's member.join, then
  // Bob's first group message. The pipeline applies each to completion before
  // the next, so the join commits Bob's membership before the message is gated.
  await pipeline.submit(frameFor({ eventId: "evt_join", inner: joinInner(), senderAccountId: JOINER }));
  await pipeline.submit(frameFor({ eventId: "evt_msg", inner: messageInner(threadId), senderAccountId: JOINER }));

  const members = await app.bus.stores.groupStore.listMembers({ ownerAccountId: INVITER, groupId: GROUP_ID });
  const ids = members.map((m) => m.accountId).sort();
  assert.deepEqual(ids, [INVITER, JOINER].sort(), "roster contains BOTH the creator and the joiner");

  const msgs = await listGroupMessages(app, threadId);
  const fromBob = msgs.find((m) => m.messageId === "msg_from_bob_1");
  assert.ok(fromBob, "Bob's group message survived catch-up (not dropped by the membership gate)");
  assert.equal(fromBob.senderAccountId, JOINER);
});

test("serialized pipeline: concurrent submits (live-push burst) still apply in order, not raced", async () => {
  // The live-push path fire-and-forgets into the SAME pipeline (submit without
  // awaiting). The internal queue must still serialize: a member.join + message
  // burst submitted back-to-back, neither awaited individually, must apply in
  // order so the message is not dropped. This is the online back-to-back race
  // the unified pipeline closes.
  const app = await setupInviterServer();
  const threadId = app.bus.services.threads.groupThreadId(GROUP_ID);
  const pipeline = new InboundDepositPipeline({
    peerLinkProtocol: makeStubPeerLinkProtocol(),
    events: app.bus.services.events,
  });

  // Fire both without awaiting between them; await only the second (which, via
  // the #tail chain, resolves after the first has fully applied).
  pipeline.submit(frameFor({ eventId: "evt_join_c", inner: joinInner(), senderAccountId: JOINER }));
  await pipeline.submit(frameFor({ eventId: "evt_msg_c", inner: messageInner(threadId), senderAccountId: JOINER }));

  const msgs = await listGroupMessages(app, threadId);
  assert.ok(msgs.some((m) => m.messageId === "msg_from_bob_1"),
    "burst-submitted message survives — the queue serialized join-before-message");
});

test("ordering hazard: a group message applied BEFORE the sender's member.join is dropped (what the pipeline prevents)", async () => {
  // This is the pre-fix behaviour the serialized pipeline eliminates: if the
  // message is processed before the join commits membership, the fail-closed
  // group-content gate drops it permanently.
  const app = await setupInviterServer();
  const threadId = app.bus.services.threads.groupThreadId(GROUP_ID);

  // Apply the message FIRST (Bob not yet a member) ...
  await app.bus.services.events.applyUserMessage({
    eventId: "evt_msg_early",
    mailboxId: "inbox:alice",
    plaintextB64: Buffer.from(JSON.stringify(messageInner(threadId))).toString("base64"),
    senderAccountId: JOINER,
  });
  // ... then the join.
  await app.bus.services.events.applyUserMessage({
    eventId: "evt_join_late",
    mailboxId: "inbox:alice",
    plaintextB64: Buffer.from(JSON.stringify(joinInner())).toString("base64"),
    senderAccountId: JOINER,
  });

  const msgs = await listGroupMessages(app, threadId);
  const fromBob = msgs.find((m) => m.messageId === "msg_from_bob_1");
  assert.ok(!fromBob, "out-of-order: the message was dropped by the membership gate (the bug)");
  // The late join still establishes membership — but the message is already lost.
  const members = await app.bus.stores.groupStore.listMembers({ ownerAccountId: INVITER, groupId: GROUP_ID });
  assert.ok(members.some((m) => m.accountId === JOINER), "join still applied; only the earlier message was lost");
});
