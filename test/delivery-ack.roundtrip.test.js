// delivery-ack.roundtrip.test.js
//
// Integration roundtrip for the sent → delivered status transition. Drives
// two real ChatServerApp instances side-by-side. Alice sends a 1:1 chat
// message; Bob's chat layer is expected to send a `E2eeDeliveryAckV1` back
// carrying Alice's *local* messageId (NOT the relay's inbound eventId).
// Alice's ServerEventService.#handleDeliveryAck routes that into
// ServerMessagesService.handleDeliveryAck, which flips the stored row to
// `status: "delivered"` and emits a `message.status` event.
//
// The regression this guards: previously the ack was sent at the protocol
// layer (ServerPeerLinkProtocolService) with `messageIds: [eventId]` —
// the inbound relay deposit eventId. Alice's storage is keyed by the
// sender-generated `messageId` (e.g. "mid_abc"), so the ack's id never
// matched any row and `setMessageStatus` silently no-op'd. Per feedback
// memory `feedback_mocked_tests_hide_crypto_bugs`, unit tests with mocked
// SDKs hid this — the chat-server's real ingest/ack code runs here.

import test from "node:test";
import assert from "node:assert/strict";
import { ChatServerApp } from "../src/server/app/ChatServerApp.js";
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
  getObjectStore() { return { deposit: async () => ({}), list: async () => [] }; }
  getMailboxStore() { return { deposit: async () => ({}), poll: async () => [] }; }
}

const FAKE_IDENTITY_KEYS = {
  publicKeyB64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  privateKeyB64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
};

const ALICE = "rez:acct:alice";
const BOB = "rez:acct:bob";
const ALICE_DM_THREAD = "th_dm_alice_bob_a";
const BOB_DM_THREAD = "th_dm_alice_bob_b";
const GROUP_ID = "grp_delivery_ack_group_case";
const GROUP_THREAD = "th_" + GROUP_ID;

function makeServer({ ownerAccountId, storage, sendCapture, clock }) {
  const sdk = {
    ...makeSealDispatch({ onSend: (opts) => { if (Array.isArray(sendCapture)) sendCapture.push(opts); } }),
    getIdentity: () => ({ localInboxId: "inbox:" + ownerAccountId }),
  };
  return new ChatServerApp({
    identity: { ...FAKE_IDENTITY_KEYS, accountId: ownerAccountId, deviceId: "dev:" + ownerAccountId },
    uplinks: ["ws://localhost:9999"],
    storageProvider: storage,
    ownerAccountId,
    clock,
    sdk,
  });
}

async function seedDirectThread({ storage, ownerAccountId, threadId, peerAccountId, peerInboxId }) {
  const kv = storage.getKeyValueStore(ownerAccountId);
  await kv.set("app:threads/" + ownerAccountId + "/" + threadId, {
    threadId,
    threadType: "direct",
    peerAccountId,
    peerInboxId,
    createdAtMs: 500,
    updatedAtMs: 500,
  });
}

async function seedGroupThread({ storage, ownerAccountId }) {
  const kv = storage.getKeyValueStore(ownerAccountId);
  await kv.set("app:threads/" + ownerAccountId + "/" + GROUP_THREAD, {
    threadId: GROUP_THREAD,
    threadType: "group",
    groupId: GROUP_ID,
    title: "Group case",
    createdAtMs: 500,
    updatedAtMs: 500,
  });
}

function nextEventId() {
  nextEventId._counter = (nextEventId._counter || 0) + 1;
  return "evt_" + nextEventId._counter;
}

// Drain sender's captured seal-for-peer buffer and route each to the
// receiver's bus. Delivery acks (`kind === "rez.delivery.ack"`) are
// dispatched via the `delivery.ack` bus event — that's what
// ServerPeerLinkProtocolService does after decrypt. Everything else is
// dispatched as `peerlink.user.message`.
async function deliverToReceiver({ senderServer, receiverServer, sentBuf, expectedPeerAccountId }) {
  const drained = sentBuf.splice(0, sentBuf.length);
  for (const opts of drained) {
    if (opts.peerAccountId !== expectedPeerAccountId) continue;
    const plaintextBytes = opts.plaintextBodyBytes;
    let parsed = null;
    try {
      parsed = JSON.parse(Buffer.from(plaintextBytes).toString("utf8"));
    } catch {
      parsed = null;
    }
    if (parsed && parsed.kind === "rez.delivery.ack"
        && typeof parsed.senderAccountId === "string"
        && Array.isArray(parsed.messageIds)) {
      receiverServer.bus.emit("delivery.ack", {
        senderAccountId: parsed.senderAccountId,
        messageIds: parsed.messageIds,
      });
      continue;
    }
    const b64 = Buffer.from(plaintextBytes).toString("base64");
    await receiverServer.bus.services.events.applyUserMessage({
      mailboxId: "inbox:" + expectedPeerAccountId,
      eventId: nextEventId(),
      plaintextB64: b64,
      senderAccountId: senderServer.ownerAccountId,
      snapshot: {
        peerAccountId: senderServer.ownerAccountId,
        peerInboxId: "inbox:" + senderServer.ownerAccountId,
      },
    });
  }
}

async function waitForCondition(check, { timeoutMs = 1000, intervalMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

async function startBoth(servers) {
  for (const server of servers) {
    if (!server.bus.runtime) server.bus.runtime = {};
    if (!server.bus.runtime.sdk) server.bus.runtime.sdk = {};
    if (!server.bus.runtime.sdk.subscriptions) {
      server.bus.runtime.sdk.subscriptions = {
        onMailboxDeposited: () => () => {},
      };
    }
    await server.bus.services.events.start();
    if (server.bus.services.messages && typeof server.bus.services.messages.start === "function") {
      await server.bus.services.messages.start();
    }
  }
}

test("delivery ack: 1:1 chat message transitions alice's row from sent → delivered", async () => {
  const aliceStorage = new TestStorageProvider();
  const bobStorage = new TestStorageProvider();
  const aliceSent = [];
  const bobSent = [];
  let now = 1000;
  const clock = () => (now += 100);

  await seedDirectThread({
    storage: aliceStorage, ownerAccountId: ALICE, threadId: ALICE_DM_THREAD,
    peerAccountId: BOB, peerInboxId: "inbox:" + BOB,
  });
  await seedDirectThread({
    storage: bobStorage, ownerAccountId: BOB, threadId: BOB_DM_THREAD,
    peerAccountId: ALICE, peerInboxId: "inbox:" + ALICE,
  });

  const alice = makeServer({ ownerAccountId: ALICE, storage: aliceStorage, sendCapture: aliceSent, clock });
  const bob = makeServer({ ownerAccountId: BOB, storage: bobStorage, sendCapture: bobSent, clock });
  await startBoth([alice, bob]);

  // Pre-seed a thread row keyed by the wire payload's threadId on Bob's
  // side too, so the inbound payload finds a known thread. The payload
  // carries Alice's threadId (ALICE_DM_THREAD); Bob's matching thread row
  // points back at Alice as the peer.
  await bobStorage.getKeyValueStore(BOB).set("app:threads/" + BOB + "/" + ALICE_DM_THREAD, {
    threadId: ALICE_DM_THREAD,
    threadType: "direct",
    peerAccountId: ALICE,
    peerInboxId: "inbox:" + ALICE,
    createdAtMs: 500,
    updatedAtMs: 500,
  });

  const aliceStatuses = [];
  alice.bus.on("message.status", (evt) => aliceStatuses.push(evt));

  const MID = "mid_alice_first";
  await alice.bus.services.messages.sendMessage({
    threadId: ALICE_DM_THREAD,
    messageId: MID,
    payload: { kind: "rez.chat.message.v1", text: "hello bob" },
  });

  // After Alice's local deposit succeeds, status should be "sent".
  const sentOk = await waitForCondition(() => aliceStatuses.some((e) => e.messageId === MID && e.status === "sent"));
  assert.equal(sentOk, true, "alice should observe status sent after local deposit");

  // Bridge Alice's outbound chat message → Bob's bus.
  await deliverToReceiver({ senderServer: alice, receiverServer: bob, sentBuf: aliceSent, expectedPeerAccountId: BOB });

  // Bob's chat layer should respond with a delivery ack. The ack's
  // messageIds must carry Alice's local messageId, not Bob's inbound
  // relay eventId — that's the bug this test guards against.
  const ackCaptured = await waitForCondition(() => bobSent.some((opts) => {
    try {
      const parsed = JSON.parse(Buffer.from(opts.plaintextBodyBytes).toString("utf8"));
      return parsed && parsed.kind === "rez.delivery.ack";
    } catch { return false; }
  }));
  assert.equal(ackCaptured, true, "bob should send a delivery ack for the inbound chat message");

  const ackOpts = bobSent.find((opts) => {
    try {
      const parsed = JSON.parse(Buffer.from(opts.plaintextBodyBytes).toString("utf8"));
      return parsed && parsed.kind === "rez.delivery.ack";
    } catch { return false; }
  });
  const ackBody = JSON.parse(Buffer.from(ackOpts.plaintextBodyBytes).toString("utf8"));
  assert.deepEqual(ackBody.messageIds, [MID], "ack must carry sender's local messageId, not the relay eventId");
  assert.equal(ackOpts.peerAccountId, ALICE, "ack must be addressed to alice");
  assert.equal(ackOpts.deliverInboxId, "inbox:" + ALICE, "ack must target alice's inbox");

  // Bridge Bob's ack → Alice. deliverToReceiver detects the ack kind and
  // routes it via the `delivery.ack` bus event (matching what
  // ServerPeerLinkProtocolService does in production).
  await deliverToReceiver({ senderServer: bob, receiverServer: alice, sentBuf: bobSent, expectedPeerAccountId: ALICE });

  const deliveredOk = await waitForCondition(() => aliceStatuses.some((e) => e.messageId === MID && e.status === "delivered"));
  assert.equal(deliveredOk, true, "alice's row should transition to delivered after ack");
});

// DT-004 group-ack split-brain repair. Before: the sender registered every
// group fan-out copy as expecting an E2E delivery-ack (recordOutboundGroupMessage,
// the only sender-side desync evidence) while receivers SUPPRESSED group acks —
// so the evidence was structurally false and healthy-but-quiet links got
// re-invited. The repaired contract: group members DO ack (resolved via the
// sender's peer link, since a group thread has no peer identity), and the
// sender's STATUS semantics stay 1:1-only (a group row never flips to
// "delivered" on the first of N member acks — group messageIds are not
// ack-pending-registered).
test("DT-004: group fan-out triggers member acks (recovery evidence) without flipping the sender's group row to delivered", async () => {
  const aliceStorage = new TestStorageProvider();
  const bobStorage = new TestStorageProvider();
  const aliceSent = [];
  const bobSent = [];
  let now = 1000;
  const clock = () => (now += 100);

  // Seed a direct thread on Bob so #resolveDirectThreadForSender can
  // attribute the inbound group message to Alice as the sender.
  await seedDirectThread({
    storage: bobStorage, ownerAccountId: BOB, threadId: BOB_DM_THREAD,
    peerAccountId: ALICE, peerInboxId: "inbox:" + ALICE,
  });
  await seedGroupThread({ storage: aliceStorage, ownerAccountId: ALICE });
  await seedGroupThread({ storage: bobStorage, ownerAccountId: BOB });

  const alice = makeServer({ ownerAccountId: ALICE, storage: aliceStorage, sendCapture: aliceSent, clock });
  const bob = makeServer({ ownerAccountId: BOB, storage: bobStorage, sendCapture: bobSent, clock });
  await startBoth([alice, bob]);

  // Both sides need ACTIVE group membership for fan-out + ingestion to allow
  // the message through. Seed through the real GroupStore API — the previous
  // raw "app:groups/.../members/..." key seeds never matched the membership
  // table's hashed "app:groupMembership/" layout, so the old version of this
  // test asserted "no acks" against a fan-out that had zero targets (vacuous).
  for (const [server, owner] of [[alice, ALICE], [bob, BOB]]) {
    await server.bus.stores.groupStore.ensureGroup({ ownerAccountId: owner, groupId: GROUP_ID, createdBy: ALICE, title: "Group case" });
    await server.bus.stores.groupStore.ensureMembership({ ownerAccountId: owner, groupId: GROUP_ID, accountId: ALICE, role: "admin" });
    await server.bus.stores.groupStore.ensureMembership({ ownerAccountId: owner, groupId: GROUP_ID, accountId: BOB, role: "member" });
  }

  // Bob's ack path resolves Alice's return inbox from her peer link (a group
  // thread carries no peer identity). Back the peer-links list directive with
  // the link the group message would have decrypted over.
  bob.bus.runtime.peerLinks = {
    ownerAccountId: BOB,
    peerLinkStorage: {
      peerLinks: {
        listByOwner: async () => [{
          peerLinkId: "pl_bob_alice",
          localAccountId: BOB,
          peerAccountId: ALICE,
          peerInboxId: "inbox:" + ALICE,
          state: "session_established",
        }],
      },
    },
  };

  // Sender side: group fan-out must still register recovery evidence per
  // recipient — that is the mechanism the receiver-side ack now feeds.
  const recovered = [];
  const peerLinkProtocol = alice.bus.services.peerLinkProtocol;
  const origRecord = peerLinkProtocol.recordOutboundGroupMessage.bind(peerLinkProtocol);
  peerLinkProtocol.recordOutboundGroupMessage = (args) => { recovered.push(args); return origRecord(args); };

  const aliceStatuses = [];
  alice.bus.on("message.status", (e) => aliceStatuses.push(e));

  await alice.bus.services.messages.sendMessage({
    threadId: GROUP_THREAD,
    messageId: "mid_group_msg",
    payload: { kind: "rez.chat.message.v1", text: "hi team" },
  });
  assert.equal(recovered.length, 1, "sender registered the fan-out copy as expecting an ack");
  assert.equal(recovered[0].peerAccountId, BOB);

  await deliverToReceiver({ senderServer: alice, receiverServer: bob, sentBuf: aliceSent, expectedPeerAccountId: BOB });

  // Bob acked the group message, sealed to Alice at her peer-link inbox.
  const ackArrived = await waitForCondition(() => bobSent.some((opts) => {
    try {
      const parsed = JSON.parse(Buffer.from(opts.plaintextBodyBytes).toString("utf8"));
      return parsed && parsed.kind === "rez.delivery.ack";
    } catch { return false; }
  }));
  assert.equal(ackArrived, true, "group message triggers a delivery ack from the member");
  const ackSends = bobSent.filter((opts) => {
    try {
      const parsed = JSON.parse(Buffer.from(opts.plaintextBodyBytes).toString("utf8"));
      return parsed && parsed.kind === "rez.delivery.ack";
    } catch { return false; }
  });
  assert.equal(ackSends.length, 1, "exactly one ack per member per message");
  assert.equal(ackSends[0].peerAccountId, ALICE, "ack sealed to the authenticated sender");
  assert.equal(ackSends[0].deliverInboxId, "inbox:" + ALICE, "ack routed to the sender's peer-link inbox");
  const ackBody = JSON.parse(Buffer.from(ackSends[0].plaintextBodyBytes).toString("utf8"));
  assert.deepEqual(ackBody.messageIds, ["mid_group_msg"], "ack carries the sender's local messageId");

  // Route the ack back to Alice: her group row must NOT flip to "delivered"
  // (group messageIds are not ack-pending-registered — the ack feeds recovery
  // evidence only, never the N-ack-ambiguous group status).
  await deliverToReceiver({ senderServer: bob, receiverServer: alice, sentBuf: bobSent, expectedPeerAccountId: ALICE });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(
    aliceStatuses.some((e) => e.messageId === "mid_group_msg" && e.status === "delivered"),
    false,
    "a group row never transitions to delivered on a member ack",
  );
});
