// member.join op coverage: the canonical bootstrap signal for group
// membership. Replaces the snapshot.groupId side-channel that previously
// caused inviter-side membership drift.
//
// Scope of this file:
//   - acceptor side: invite.accept emits a member.join op via the SDK
//   - inviter side: inbound member.join materializes thread + membership
//     + persists the "X joined" system message; forwards to the rest of
//     the group (shape B)
//   - forwarded member.join (sender != joiner) is honored only when the
//     forwarder is an active group member
//   - redelivery of the same op is idempotent (no second system message,
//     no re-fanout)
//   - member.join with no matching local invite is dropped

import test from "node:test";
import assert from "node:assert/strict";

import { ChatServerApp } from "../src/server/app/ChatServerApp.js";
import { GroupOpPayloadV1 } from "../src/records/payloads/GroupOpPayloadV1.js";
import { SYSTEM_EVENT_KIND } from "../src/records/payloads/ChatSystemEventPayloadV1.js";
import { encodeInviteCodeV3 } from "@rezprotocol/sdk/client";
import { makeSealDispatch } from "./support/sealDispatchDouble.js";

// Realistic DER-SPKI Ed25519 key the v3 code commits to; the inner envelope
// must be signed by the same identity (signerRef.signerPublicKeyB64).
const INVITER_PUB = "MCowBQYDK2VwAyEA2crNvu+ZeiFMoMNP/imhLa/HIyYg6x96US6AyOqijPg=";

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

function createServer({ identity, sdk, peerLinks, clock = () => 1000 } = {}) {
  const app = new ChatServerApp({
    identity: { ...FAKE_KEYS, ...identity },
    uplinks: ["ws://localhost:9999"],
    storageProvider: new TestStorageProvider(),
    ownerAccountId: identity.accountId,
    clock,
  });
  app.bus.runtime.sdk = sdk;
  app.bus.runtime.peerLinks = peerLinks;
  return app;
}

function decodeGroupOpFromDeposit(opts) {
  const bytes = opts && opts.plaintextBodyBytes instanceof Uint8Array
    ? opts.plaintextBodyBytes : null;
  if (!bytes) return null;
  const text = new TextDecoder().decode(bytes);
  const obj = JSON.parse(text);
  return new GroupOpPayloadV1(obj);
}

// --- Acceptor side --------------------------------------------------------

test("acceptor side: invite.accept emits a member.join op to the inviter", async () => {
  let now = 1000;
  const inviteId = "plinv_grp_alpha";
  const groupId = "grp_alpha";
  const inviterAccountId = "rez:acct:alice";
  const acceptorAccountId = "rez:acct:bob";

  const sends = [];
  const sdk = {
    getIdentity: () => ({ localInboxId: "inbox:bob" }),
    mailbox: { deposit: async () => ({ eventId: "evt-1" }) },
    ...makeSealDispatch({ onSend: (opts) => sends.push(opts) }),
    peerLinks: { getPeerLink: async () => groupSnapshot },
  };
  const groupSnapshot = {
    peerLinkId: "pl_grp_alpha",
    state: "session_established",
    sessionState: "active",
    localAccountId: acceptorAccountId,
    peerAccountId: inviterAccountId,
    peerInboxId: "inbox:alice",
    groupId,
  };
  const inviteEnvelope = {
    envelope: {
      inviteId,
      kind: "group",
      groupId,
      title: "Alpha Group",
      creatorDisplayName: "Alice",
      signerRef: { signerPublicKeyB64: INVITER_PUB },
    },
    signatureB64: "sig",
  };
  const fakePeerLinks = {
    ownerAccountId: acceptorAccountId,
    getStoredInviteEnvelope: async () => inviteEnvelope,
    acceptInvite: async () => ({ snapshot: groupSnapshot, event: null }),
  };

  const server = createServer({
    identity: { accountId: acceptorAccountId, deviceId: "dev:bob" },
    clock: () => (now += 1),
    sdk, peerLinks: fakePeerLinks,
  });

  const inviteCode = encodeInviteCodeV3({ inviteId, publisherPublicKeyB64: INVITER_PUB });
  const accepted = await server.bus.call("invite", "accept", {
    inviteCode,
    acceptorDisplayName: "Bob",
  });
  assert.equal(accepted.groupId, groupId);

  // sendEncryptedDeposit should have been called once with a member.join
  // op addressed to the inviter.
  assert.equal(sends.length, 1, "exactly one outbound member.join send");
  assert.equal(sends[0].peerAccountId, inviterAccountId);
  const op = decodeGroupOpFromDeposit(sends[0]);
  assert.ok(op);
  assert.equal(op.op, "member.join");
  assert.equal(op.groupId, groupId);
  assert.equal(op.accountId, acceptorAccountId, "joiner identifies as Bob");
  assert.equal(op.inviteId, inviteId, "inviter authorization handle preserved");
  assert.equal(op.displayName, "Bob");
});

// --- Inviter side ---------------------------------------------------------

async function setupInviterServerForJoin({ inviterAccountId, groupId, inviteId, otherMembers = [] }) {
  const sends = [];
  const sdk = {
    getIdentity: () => ({ localInboxId: "inbox:alice" }),
    mailbox: { deposit: async () => ({ eventId: "evt-x" }) },
    ...makeSealDispatch({ onSend: (opts) => sends.push(opts) }),
    peerLinks: { getPeerLink: async () => null },
  };
  // Local invite record stored by the inviter — drives the join
  // authorization on the inviter side.
  const inviteRecord = {
    envelope: {
      inviteId,
      kind: "group",
      groupId,
      creatorAccountId: inviterAccountId,
      title: "Alpha",
    },
    signatureB64: "sig",
  };
  const fakePeerLinks = {
    ownerAccountId: inviterAccountId,
    getStoredInviteEnvelope: async (_owner, id) => (id === inviteId ? inviteRecord : null),
    // The invite-ledger authorization (expiry + maxUses) is exercised
    // separately; here we authorize so these tests focus on membership +
    // fan-out behavior.
    authorizeInviteJoin: async () => ({ authorized: true, reason: "CONSUMED" }),
  };
  let now = 5000;
  const server = createServer({
    identity: { accountId: inviterAccountId, deviceId: "dev:alice" },
    clock: () => (now += 1),
    sdk, peerLinks: fakePeerLinks,
  });
  // Pre-seed the inviter's own group state: group exists, Alice is admin,
  // optional other existing members (Carol, Dave) are already active. This
  // mirrors the state right after the inviter created the group; the
  // member.join is the bootstrap signal that adds the new peer.
  // Match real inviter state: the group thread + their own membership
  // already exist (they were created when the inviter ran group.create).
  // Without this, the first ensureGroupThread call from inside
  // #applyIncomingMemberJoin fires its own redundant group.members.updated.
  await server.bus.services.threads.ensureGroupThread({
    groupId, title: "Alpha", createdAtMs: 4000,
  });
  await server.bus.stores.groupStore.ensureMembership({
    ownerAccountId: inviterAccountId, groupId, accountId: inviterAccountId, role: "admin",
  });
  for (const m of otherMembers) {
    await server.bus.stores.groupStore.ensureMembership({
      ownerAccountId: inviterAccountId, groupId, accountId: m, role: "member",
    });
  }
  return { server, sends };
}

test("inviter side: inbound member.join materializes membership + persists system message", async () => {
  const inviterAccountId = "rez:acct:alice";
  const joinerAccountId = "rez:acct:bob";
  const groupId = "grp_beta";
  const inviteId = "plinv_beta";

  const { server } = await setupInviterServerForJoin({ inviterAccountId, groupId, inviteId });

  const memberEvents = [];
  server.bus.on("group.members.updated", (e) => memberEvents.push(e));

  const op = new GroupOpPayloadV1({
    op: "member.join",
    groupId,
    accountId: joinerAccountId,
    inviteId,
    displayName: "Bob",
    actedAtMs: 6000,
    groupOpId: "gop_join_1",
  });
  await server.bus.services.groups.handleIncomingGroupOp(op, {
    senderAccountId: joinerAccountId,
  });

  const members = await server.bus.stores.groupStore.listMembers({
    ownerAccountId: inviterAccountId, groupId,
  });
  const ids = members.map((m) => m.accountId).sort();
  assert.deepEqual(ids, [inviterAccountId, joinerAccountId].sort(),
    "joiner is now an active group member");
  assert.equal(memberEvents.length, 1, "group.members.updated emitted");

  // System message persisted into the group thread.
  const threadId = server.bus.services.threads.groupThreadId(groupId);
  const page = await server.bus.stores.threadStore.listMessages({ threadId, limit: 10 });
  const items = page && Array.isArray(page.items) ? page.items : [];
  const sys = items.find((m) => m.payload && m.payload.kind === SYSTEM_EVENT_KIND);
  assert.ok(sys, "system join message persisted");
  assert.equal(sys.payload.event, "member.join");
  assert.equal(sys.payload.actorAccountId, joinerAccountId);
  assert.equal(sys.payload.actorDisplayName, "Bob");
  assert.equal(sys.messageId, "sys:join:gop_join_1");
});

test("inviter side: shape-B fan-out forwards member.join to other existing members", async () => {
  const inviterAccountId = "rez:acct:alice";
  const joinerAccountId = "rez:acct:bob";
  const carol = "rez:acct:carol";
  const dave = "rez:acct:dave";
  const groupId = "grp_gamma";
  const inviteId = "plinv_gamma";

  const { server, sends } = await setupInviterServerForJoin({
    inviterAccountId, groupId, inviteId, otherMembers: [carol, dave],
  });

  const op = new GroupOpPayloadV1({
    op: "member.join",
    groupId,
    accountId: joinerAccountId,
    inviteId,
    displayName: "Bob",
    actedAtMs: 6000,
    groupOpId: "gop_join_gamma",
  });
  await server.bus.services.groups.handleIncomingGroupOp(op, {
    senderAccountId: joinerAccountId,
  });

  // Forward should hit Carol and Dave but NOT Bob (the joiner) and NOT
  // Alice (self). Order is not guaranteed.
  assert.equal(sends.length, 2, "fanned out to two members (Carol, Dave)");
  const targets = sends.map((s) => s.peerAccountId).sort();
  assert.deepEqual(targets, [carol, dave].sort());
  // The forwarded op carries the same groupOpId so downstream replays
  // collapse against the original.
  for (const s of sends) {
    const forwarded = decodeGroupOpFromDeposit(s);
    assert.equal(forwarded.op, "member.join");
    assert.equal(forwarded.groupOpId, "gop_join_gamma");
    assert.equal(forwarded.accountId, joinerAccountId);
  }
});

test("inviter side: redelivery of the same member.join is a no-op (idempotent)", async () => {
  const inviterAccountId = "rez:acct:alice";
  const joinerAccountId = "rez:acct:bob";
  const groupId = "grp_delta";
  const inviteId = "plinv_delta";

  const { server, sends } = await setupInviterServerForJoin({ inviterAccountId, groupId, inviteId });

  const op = new GroupOpPayloadV1({
    op: "member.join",
    groupId,
    accountId: joinerAccountId,
    inviteId,
    displayName: "Bob",
    actedAtMs: 6000,
    groupOpId: "gop_join_delta",
  });
  await server.bus.services.groups.handleIncomingGroupOp(op, { senderAccountId: joinerAccountId });
  await server.bus.services.groups.handleIncomingGroupOp(op, { senderAccountId: joinerAccountId });

  const members = await server.bus.stores.groupStore.listMembers({
    ownerAccountId: inviterAccountId, groupId,
  });
  assert.equal(members.length, 2, "Alice + Bob, not duplicated");

  // First apply forwards to no one (2-party group). Second apply: ensureMembership
  // returns created=false so no extra system message, no extra fan-out.
  assert.equal(sends.length, 0, "no fan-out targets in 2-party group");

  // System message exists exactly once.
  const threadId = server.bus.services.threads.groupThreadId(groupId);
  const page = await server.bus.stores.threadStore.listMessages({ threadId, limit: 50 });
  const items = page && Array.isArray(page.items) ? page.items : [];
  const sysCount = items.filter((m) => m.payload && m.payload.kind === SYSTEM_EVENT_KIND).length;
  assert.equal(sysCount, 1, "exactly one system message after redelivery");
});

test("inviter side: member.join with unknown inviteId is dropped (no membership change)", async () => {
  const inviterAccountId = "rez:acct:alice";
  const joinerAccountId = "rez:acct:eve";
  const groupId = "grp_epsilon";
  const inviteId = "plinv_epsilon";

  const { server } = await setupInviterServerForJoin({ inviterAccountId, groupId, inviteId });

  const forgedOp = new GroupOpPayloadV1({
    op: "member.join",
    groupId,
    accountId: joinerAccountId,
    inviteId: "plinv_does_not_exist",
    actedAtMs: 7000,
    groupOpId: "gop_forged",
  });
  await server.bus.services.groups.handleIncomingGroupOp(forgedOp, { senderAccountId: joinerAccountId });

  const members = await server.bus.stores.groupStore.listMembers({
    ownerAccountId: inviterAccountId, groupId,
  });
  const ids = members.map((m) => m.accountId);
  assert.equal(ids.includes(joinerAccountId), false, "forged joiner is not added");
});

test("forwarded member.join: honored when forwarder is an active group member", async () => {
  // Setup Carol's perspective: she is a member of grp_gamma; Alice is too.
  // Alice forwards Bob's join. Carol applies (no invite-record check —
  // she trusts Alice's group membership).
  const carolAccountId = "rez:acct:carol";
  const aliceAccountId = "rez:acct:alice";
  const bobAccountId = "rez:acct:bob";
  const groupId = "grp_gamma_forward";

  const sdk = {
    getIdentity: () => ({ localInboxId: "inbox:carol" }),
    mailbox: { deposit: async () => ({ eventId: "evt-c" }) },
    ...makeSealDispatch(),
    peerLinks: { getPeerLink: async () => null },
  };
  // Carol has no invite record (not the inviter).
  const fakePeerLinks = { ownerAccountId: carolAccountId, getStoredInviteEnvelope: async () => null };

  let now = 9000;
  const server = createServer({
    identity: { accountId: carolAccountId, deviceId: "dev:carol" },
    clock: () => (now += 1),
    sdk, peerLinks: fakePeerLinks,
  });
  // Realistic Carol state: she has the group thread (created when she
  // herself joined) + her own admin membership + knows Alice is admin.
  await server.bus.services.threads.ensureGroupThread({
    groupId, title: "g", createdAtMs: 9000,
  });
  await server.bus.stores.groupStore.ensureMembership({
    ownerAccountId: carolAccountId, groupId, accountId: aliceAccountId, role: "admin",
  });

  const op = new GroupOpPayloadV1({
    op: "member.join",
    groupId,
    accountId: bobAccountId,
    inviteId: "plinv_alice_issued_bobs",
    actedAtMs: 9100,
    groupOpId: "gop_forwarded_join",
  });
  // Forwarded BY Alice (an active member), not by Bob himself.
  await server.bus.services.groups.handleIncomingGroupOp(op, { senderAccountId: aliceAccountId });

  const members = await server.bus.stores.groupStore.listMembers({
    ownerAccountId: carolAccountId, groupId,
  });
  const ids = members.map((m) => m.accountId).sort();
  assert.deepEqual(ids, [carolAccountId, aliceAccountId, bobAccountId].sort(),
    "Bob added on Carol's side via Alice's forward");
});

test("forwarded member.join: dropped when forwarder is not an active group member", async () => {
  const carolAccountId = "rez:acct:carol";
  const malloryAccountId = "rez:acct:mallory";
  const bobAccountId = "rez:acct:bob";
  const groupId = "grp_gamma_drop";

  const sdk = {
    getIdentity: () => ({ localInboxId: "inbox:carol" }),
    mailbox: { deposit: async () => ({ eventId: "evt-c" }) },
    ...makeSealDispatch(),
    peerLinks: { getPeerLink: async () => null },
  };
  const fakePeerLinks = { ownerAccountId: carolAccountId, getStoredInviteEnvelope: async () => null };

  let now = 10000;
  const server = createServer({
    identity: { accountId: carolAccountId, deviceId: "dev:carol" },
    clock: () => (now += 1),
    sdk, peerLinks: fakePeerLinks,
  });
  await server.bus.services.threads.ensureGroupThread({
    groupId, title: "g", createdAtMs: 9900,
  });

  const op = new GroupOpPayloadV1({
    op: "member.join",
    groupId,
    accountId: bobAccountId,
    inviteId: "plinv_x",
    actedAtMs: 10100,
    groupOpId: "gop_mallory_forwarded",
  });
  await server.bus.services.groups.handleIncomingGroupOp(op, { senderAccountId: malloryAccountId });

  const members = await server.bus.stores.groupStore.listMembers({
    ownerAccountId: carolAccountId, groupId,
  });
  const ids = members.map((m) => m.accountId);
  assert.equal(ids.includes(bobAccountId), false, "Mallory's forward is not honored");
});

// --- member.join authorization + anti-resurrection (M3 / M4 / scenario-2) ---

function makeInviterServerWithInvites({ inviterAccountId, groupId, invites, authorize, clockRef }) {
  const sends = [];
  const sdk = {
    getIdentity: () => ({ localInboxId: "inbox:" + inviterAccountId }),
    mailbox: { deposit: async () => ({ eventId: "evt" }) },
    ...makeSealDispatch({ onSend: (opts) => sends.push(opts) }),
    peerLinks: { getPeerLink: async () => null },
  };
  const fakePeerLinks = {
    ownerAccountId: inviterAccountId,
    getStoredInviteEnvelope: async (_o, id) => {
      const inv = invites[id];
      if (!inv) return null;
      return {
        envelope: {
          inviteId: id, kind: "group", groupId,
          creatorAccountId: inviterAccountId, title: "G",
          createdAtMs: inv.createdAtMs,
        },
        signatureB64: "sig",
      };
    },
    authorizeInviteJoin: authorize || (async () => ({ authorized: true, reason: "CONSUMED" })),
  };
  const server = createServer({
    identity: { accountId: inviterAccountId, deviceId: "dev:" + inviterAccountId },
    clock: () => clockRef.now,
    sdk, peerLinks: fakePeerLinks,
  });
  return { server, sends };
}

test("inviter side: member.join is dropped when invite authorization fails (expired/used-up)", async () => {
  const clockRef = { now: 5000 };
  const inviterAccountId = "rez:acct:alice";
  const joiner = "rez:acct:bob";
  const groupId = "grp_authz_mj";
  const inviteId = "plinv_authz";
  const { server } = makeInviterServerWithInvites({
    inviterAccountId, groupId,
    invites: { [inviteId]: { createdAtMs: 100 } },
    authorize: async () => ({ authorized: false, reason: "INVITE_USED_UP" }),
    clockRef,
  });
  await server.bus.services.threads.ensureGroupThread({ groupId, title: "G", createdAtMs: 100 });
  await server.bus.stores.groupStore.ensureMembership({
    ownerAccountId: inviterAccountId, groupId, accountId: inviterAccountId, role: "admin",
  });

  await server.bus.services.groups.handleIncomingGroupOp(new GroupOpPayloadV1({
    op: "member.join", groupId, accountId: joiner, inviteId, displayName: "Bob",
    actedAtMs: 6000, groupOpId: "gop_authz",
  }), { senderAccountId: joiner });

  const m = await server.bus.stores.groupStore.getMembership({
    ownerAccountId: inviterAccountId, groupId, accountId: joiner,
  });
  assert.ok(!m, "joiner is NOT added when the invite-ledger authorization fails");
});

test("inviter side: a kicked member is re-admitted ONLY by an invite issued AFTER the kick", async () => {
  const clockRef = { now: 100 };
  const inviterAccountId = "rez:acct:alice";
  const joiner = "rez:acct:bob";
  const groupId = "grp_resurrect";
  const staleInvite = "plinv_stale"; // createdAtMs 100 — predates the kick
  const freshInvite = "plinv_fresh"; // createdAtMs 300 — issued after the kick
  const { server } = makeInviterServerWithInvites({
    inviterAccountId, groupId,
    invites: { [staleInvite]: { createdAtMs: 100 }, [freshInvite]: { createdAtMs: 300 } },
    clockRef,
  });
  await server.bus.services.threads.ensureGroupThread({ groupId, title: "G", createdAtMs: 100 });
  await server.bus.stores.groupStore.ensureMembership({
    ownerAccountId: inviterAccountId, groupId, accountId: inviterAccountId, role: "admin",
  });

  // Bob joins originally.
  clockRef.now = 150;
  await server.bus.services.groups.handleIncomingGroupOp(new GroupOpPayloadV1({
    op: "member.join", groupId, accountId: joiner, inviteId: staleInvite, displayName: "Bob",
    actedAtMs: 150, groupOpId: "gop_j1",
  }), { senderAccountId: joiner });
  let bob = await server.bus.stores.groupStore.getMembership({
    ownerAccountId: inviterAccountId, groupId, accountId: joiner,
  });
  assert.equal(bob.state, "active", "Bob joined");

  // Alice kicks Bob at t=200 → Bob.updatedAtMs = 200.
  clockRef.now = 200;
  await server.bus.stores.groupStore.removeMember({
    ownerAccountId: inviterAccountId, groupId, accountId: joiner,
  });

  // Replay the STALE invite (createdAtMs 100 < removal 200) → REFUSED.
  clockRef.now = 250;
  await server.bus.services.groups.handleIncomingGroupOp(new GroupOpPayloadV1({
    op: "member.join", groupId, accountId: joiner, inviteId: staleInvite, displayName: "Bob",
    actedAtMs: 250, groupOpId: "gop_replay",
  }), { senderAccountId: joiner });
  bob = await server.bus.stores.groupStore.getMembership({
    ownerAccountId: inviterAccountId, groupId, accountId: joiner,
  });
  assert.equal(bob.state, "removed", "a stale invite predating the kick CANNOT resurrect Bob");

  // Use the FRESH invite (createdAtMs 300 > removal 200) → RE-ADMITTED.
  clockRef.now = 350;
  await server.bus.services.groups.handleIncomingGroupOp(new GroupOpPayloadV1({
    op: "member.join", groupId, accountId: joiner, inviteId: freshInvite, displayName: "Bob",
    actedAtMs: 350, groupOpId: "gop_fresh",
  }), { senderAccountId: joiner });
  bob = await server.bus.stores.groupStore.getMembership({
    ownerAccountId: inviterAccountId, groupId, accountId: joiner,
  });
  assert.equal(bob.state, "active", "a fresh post-kick invite re-admits Bob");
});

test("forwarded member.join CANNOT resurrect a removed member (only adds new ones)", async () => {
  // Carol's view: Alice (active member) forwards a member.join for Bob, whom
  // Carol has locally as removed. The forward must not revive Bob — only the
  // inviter's freshness-gated self-announce can.
  const carol = "rez:acct:carol";
  const alice = "rez:acct:alice";
  const bob = "rez:acct:bob";
  const groupId = "grp_fwd_noresurrect";
  const sdk = {
    getIdentity: () => ({ localInboxId: "inbox:carol" }),
    ...makeSealDispatch(),
    peerLinks: { getPeerLink: async () => null },
  };
  const fakePeerLinks = { ownerAccountId: carol, getStoredInviteEnvelope: async () => null };
  let now = 9000;
  const server = createServer({
    identity: { accountId: carol, deviceId: "dev:carol" },
    clock: () => (now += 1),
    sdk, peerLinks: fakePeerLinks,
  });
  await server.bus.services.threads.ensureGroupThread({ groupId, title: "g", createdAtMs: 9000 });
  await server.bus.stores.groupStore.ensureMembership({
    ownerAccountId: carol, groupId, accountId: alice, role: "admin",
  });
  await server.bus.stores.groupStore.ensureMembership({
    ownerAccountId: carol, groupId, accountId: bob, role: "member",
  });
  await server.bus.stores.groupStore.removeMember({ ownerAccountId: carol, groupId, accountId: bob });

  await server.bus.services.groups.handleIncomingGroupOp(new GroupOpPayloadV1({
    op: "member.join", groupId, accountId: bob, inviteId: "plinv_w",
    actedAtMs: 9100, groupOpId: "gop_fwd",
  }), { senderAccountId: alice });

  const m = await server.bus.stores.groupStore.getMembership({
    ownerAccountId: carol, groupId, accountId: bob,
  });
  assert.equal(m.state, "removed", "a forwarded join cannot resurrect a kicked member");
});

// --- Rejected group-invite teardown ---------------------------------------

test("discardGroupForRejectedInvite removes only the group joined via that one invite", async () => {
  const inviter = "rez:acct:alice";
  const me = "rez:acct:bob";
  const server = createServer({
    identity: { accountId: me },
    sdk: { getIdentity: () => ({ localInboxId: "inbox:bob" }) },
    peerLinks: { ownerAccountId: me },
    clock: () => 5000,
  });

  // Two groups joined via DIFFERENT invites from the SAME inviter, plus a group
  // we created ourselves. Only the rejected invite's group must be torn down.
  await server.bus.services.threads.ensureGroupThread({
    groupId: "grp_rejected", peerAccountId: inviter, title: "Rejected group",
    createdAtMs: 1000, joinedViaInviteId: "plinv_rejected",
  });
  await server.bus.services.threads.ensureGroupThread({
    groupId: "grp_other", peerAccountId: inviter, title: "Other group from Alice",
    createdAtMs: 1000, joinedViaInviteId: "plinv_other",
  });
  await server.bus.services.threads.ensureGroupThread({
    groupId: "grp_mine", peerAccountId: null, title: "My group", createdAtMs: 1000,
  });

  const rejectedThreadId = server.bus.services.threads.groupThreadId("grp_rejected");
  const otherThreadId = server.bus.services.threads.groupThreadId("grp_other");
  const mineThreadId = server.bus.services.threads.groupThreadId("grp_mine");
  assert.ok(await server.bus.stores.threadStore.getThread(rejectedThreadId), "rejected group thread exists");

  const removedEvents = [];
  server.bus.on("group.removed", (e) => removedEvents.push(e));

  const res = await server.bus.services.groups.discardGroupForRejectedInvite({ inviteId: "plinv_rejected" });

  assert.deepEqual(res.removed, ["grp_rejected"], "only the rejected invite's group is discarded");
  assert.ok(!(await server.bus.stores.threadStore.getThread(rejectedThreadId)),
    "the rejected invite's group thread is deleted");
  assert.ok(await server.bus.stores.threadStore.getThread(otherThreadId),
    "a different group from the same inviter is NOT touched (bound to the one invite)");
  assert.ok(await server.bus.stores.threadStore.getThread(mineThreadId),
    "a group we created ourselves is NOT touched");

  const selfMembership = await server.bus.stores.groupStore.getMembership({
    ownerAccountId: me, groupId: "grp_rejected", accountId: me,
  });
  assert.equal(selfMembership.state, "removed", "self-membership in the rejected group is removed");
  assert.equal(removedEvents.length, 1, "group.removed emitted once");
  assert.equal(removedEvents[0].groupId, "grp_rejected");
});

test("discardGroupForRejectedInvite is a no-op when no group matches the invite", async () => {
  const server = createServer({
    identity: { accountId: "rez:acct:bob" },
    sdk: { getIdentity: () => ({ localInboxId: "inbox:bob" }) },
    peerLinks: { ownerAccountId: "rez:acct:bob" },
    clock: () => 5000,
  });
  const res = await server.bus.services.groups.discardGroupForRejectedInvite({ inviteId: "plinv_nope" });
  assert.deepEqual(res.removed, []);
});
