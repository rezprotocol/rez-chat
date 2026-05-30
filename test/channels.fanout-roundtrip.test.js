// channels.fanout-roundtrip.test.js
//
// Integration roundtrip for the channels feature. Drives two real
// ChatServerApp instances side-by-side. Alice's mock SDK captures every
// `sendEncryptedDeposit` and we bridge those bytes into Bob's chat bus
// via `peerlink.user.message`, which is the exact bus event that
// ServerPeerLinkProtocolService fires after decrypting an inbound user
// payload. From there everything runs through the production
// pipeline: ServerEventService → PAYLOAD_KIND_REGISTRY →
// ServerGroupsService.handleIncomingGroupOp →
// ServerChannelsService.applyIncomingOp.
//
// This pattern matches the broader project guidance that mocked tests
// hide crypto bugs (see feedback memory). The SDK is mocked here but the
// chat-server's record validation, dispatch registry, and op-routing
// graph are the real production code under test.

import test from "node:test";
import assert from "node:assert/strict";
import { ChatServerApp } from "../src/server/app/ChatServerApp.js";
import { GroupStore } from "../src/server/storage/ChatGroupStore.js";

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
const GROUP_ID = "grp_channels_roundtrip";

function makeServer({ ownerAccountId, storage, sendCapture, clock }) {
  const sdk = {
    sendEncryptedDeposit: async (opts) => {
      if (Array.isArray(sendCapture)) sendCapture.push(opts);
      return { ok: true };
    },
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

async function seedGroupOnBothSides({ aliceStorage, bobStorage }) {
  const aliceGroups = new GroupStore({ storageProvider: aliceStorage, clock: () => 1000 });
  await aliceGroups.ensureGroup({ ownerAccountId: ALICE, groupId: GROUP_ID, createdBy: ALICE, title: "Roundtrip" });
  await aliceGroups.ensureMembership({ ownerAccountId: ALICE, groupId: GROUP_ID, accountId: ALICE, role: "admin" });
  await aliceGroups.ensureMembership({ ownerAccountId: ALICE, groupId: GROUP_ID, accountId: BOB, role: "member" });
  const bobGroups = new GroupStore({ storageProvider: bobStorage, clock: () => 1000 });
  await bobGroups.ensureGroup({ ownerAccountId: BOB, groupId: GROUP_ID, createdBy: ALICE, title: "Roundtrip" });
  await bobGroups.ensureMembership({ ownerAccountId: BOB, groupId: GROUP_ID, accountId: ALICE, role: "admin" });
  await bobGroups.ensureMembership({ ownerAccountId: BOB, groupId: GROUP_ID, accountId: BOB, role: "member" });
}

async function seedDirectThread({ ownerStorage, ownerAccountId, peerAccountId }) {
  // ServerEventService.#resolveDirectThreadForSender walks thread rows
  // looking for one matching the sender's account. For inbound group-ops
  // (which carry no senderAccountId in the payload itself), this is the
  // path that supplies the sender identity. In production, group members
  // typically have a DM with each other before being added to a group;
  // this seed mirrors that precondition.
  const kv = ownerStorage.getKeyValueStore(ownerAccountId);
  const threadId = "th_dm_" + peerAccountId.replace(/[^a-z0-9]/gi, "");
  await kv.set("app:threads/" + ownerAccountId + "/" + threadId, {
    threadId,
    threadType: "direct",
    peerAccountId,
    peerInboxId: "inbox:" + peerAccountId,
    createdAtMs: 500,
    updatedAtMs: 500,
  });
}

function nextEventId() {
  nextEventId._counter = (nextEventId._counter || 0) + 1;
  return "evt_" + nextEventId._counter;
}

function deliverToReceiver({ senderServer, receiverServer, sentBuf, expectedPeerAccountId }) {
  // Flush all captured fan-out from sender → emit each as a
  // peerlink.user.message into the receiver's bus. Matches the shape
  // ServerPeerLinkProtocolService produces after decrypt.
  const drained = sentBuf.splice(0, sentBuf.length);
  for (const opts of drained) {
    if (opts.peerAccountId !== expectedPeerAccountId) continue;
    const plaintextBytes = opts.plaintextBodyBytes;
    // base64-encode the plaintext bytes for the bus event shape.
    const b64 = Buffer.from(plaintextBytes).toString("base64");
    receiverServer.bus.emit("peerlink.user.message", {
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
  // ServerEventService.start() requires the sdk to expose subscriptions —
  // wire a no-op subscription object so start() doesn't throw.
  for (const server of servers) {
    if (!server.bus.runtime) server.bus.runtime = {};
    if (!server.bus.runtime.sdk) server.bus.runtime.sdk = {};
    if (!server.bus.runtime.sdk.subscriptions) {
      server.bus.runtime.sdk.subscriptions = {
        onMailboxDeposited: () => () => {},
      };
    }
    // We only need ServerEventService listening on `peerlink.user.message`.
    await server.bus.services.events.start();
  }
}

test("channels roundtrip: alice creates → bob materializes record + emits channel.upserted", async () => {
  const aliceStorage = new TestStorageProvider();
  const bobStorage = new TestStorageProvider();
  const aliceSent = [];
  let now = 1000;
  const clock = () => (now += 100);

  await seedGroupOnBothSides({ aliceStorage, bobStorage });
  await seedDirectThread({ ownerStorage: bobStorage, ownerAccountId: BOB, peerAccountId: ALICE });

  const alice = makeServer({ ownerAccountId: ALICE, storage: aliceStorage, sendCapture: aliceSent, clock });
  const bob = makeServer({ ownerAccountId: BOB, storage: bobStorage, sendCapture: [], clock });
  await startBoth([alice, bob]);

  const bobUpserted = [];
  bob.bus.on("channel.upserted", (record) => bobUpserted.push(record));

  await alice.bus.services.channels.createChannel({ groupId: GROUP_ID, channelId: "dev" });
  deliverToReceiver({ senderServer: alice, receiverServer: bob, sentBuf: aliceSent, expectedPeerAccountId: BOB });

  const ok = await waitForCondition(async () => bobUpserted.length >= 1);
  assert.equal(ok, true, "bob should observe channel.upserted via fan-out");
  assert.equal(bobUpserted[0].channel.channelId, "dev");

  const bobChannels = await bob.bus.stores.channelStore.listChannels({ ownerAccountId: BOB, groupId: GROUP_ID });
  assert.deepEqual(bobChannels.map((c) => c.channelId), ["dev"]);
});

test("channels roundtrip: tagged message from alice causes bob to observe the channel even without a prior channel.create", async () => {
  const aliceStorage = new TestStorageProvider();
  const bobStorage = new TestStorageProvider();
  const aliceSent = [];
  let now = 1000;
  const clock = () => (now += 100);

  await seedGroupOnBothSides({ aliceStorage, bobStorage });
  await seedDirectThread({ ownerStorage: bobStorage, ownerAccountId: BOB, peerAccountId: ALICE });
  // Bob also needs the group thread to exist locally so ServerEventService
  // resolves the deposit to a known group thread (which carries .groupId).
  const groupThreadId = "th_" + GROUP_ID;
  await bobStorage.getKeyValueStore(BOB).set("app:threads/" + BOB + "/" + groupThreadId, {
    threadId: groupThreadId, threadType: "group", groupId: GROUP_ID,
    title: "Roundtrip", createdAtMs: 1000, updatedAtMs: 1000,
  });
  await aliceStorage.getKeyValueStore(ALICE).set("app:threads/" + ALICE + "/" + groupThreadId, {
    threadId: groupThreadId, threadType: "group", groupId: GROUP_ID,
    title: "Roundtrip", createdAtMs: 1000, updatedAtMs: 1000,
  });

  const alice = makeServer({ ownerAccountId: ALICE, storage: aliceStorage, sendCapture: aliceSent, clock });
  const bob = makeServer({ ownerAccountId: BOB, storage: bobStorage, sendCapture: [], clock });
  await startBoth([alice, bob]);

  // Stub group fan-out so the group-message send-path's fan-out also bridges
  // through our test bridge. ServerMessagesService uses
  // sdk.sendEncryptedDeposit for group fan-out which our mock already captures.
  const bobUpserted = [];
  bob.bus.on("channel.upserted", (record) => bobUpserted.push(record));

  await alice.bus.services.messages.sendMessage({
    threadId: groupThreadId,
    payload: { kind: "rez.chat.message.v1", text: "hi planning" },
    channelId: "planning",
  });
  deliverToReceiver({ senderServer: alice, receiverServer: bob, sentBuf: aliceSent, expectedPeerAccountId: BOB });

  const ok = await waitForCondition(async () => bobUpserted.length >= 1);
  assert.equal(ok, true, "bob should observe a channel.upserted from message-tag observation");
  assert.equal(bobUpserted[0].channel.channelId, "planning");
});

test("channels roundtrip: admin delete tombstones on bob; #general is undeletable", async () => {
  const aliceStorage = new TestStorageProvider();
  const bobStorage = new TestStorageProvider();
  const aliceSent = [];
  let now = 1000;
  const clock = () => (now += 100);

  await seedGroupOnBothSides({ aliceStorage, bobStorage });
  await seedDirectThread({ ownerStorage: bobStorage, ownerAccountId: BOB, peerAccountId: ALICE });
  const alice = makeServer({ ownerAccountId: ALICE, storage: aliceStorage, sendCapture: aliceSent, clock });
  const bob = makeServer({ ownerAccountId: BOB, storage: bobStorage, sendCapture: [], clock });
  await startBoth([alice, bob]);

  const bobRemoved = [];
  bob.bus.on("channel.removed", (record) => bobRemoved.push(record));

  // create + propagate
  await alice.bus.services.channels.createChannel({ groupId: GROUP_ID, channelId: "dev" });
  deliverToReceiver({ senderServer: alice, receiverServer: bob, sentBuf: aliceSent, expectedPeerAccountId: BOB });
  await waitForCondition(async () => {
    const list = await bob.bus.stores.channelStore.listChannels({ ownerAccountId: BOB, groupId: GROUP_ID });
    return list.length === 1;
  });

  // delete (Alice is admin in both directories)
  await alice.bus.services.channels.deleteChannel({ groupId: GROUP_ID, channelId: "dev" });
  deliverToReceiver({ senderServer: alice, receiverServer: bob, sentBuf: aliceSent, expectedPeerAccountId: BOB });
  const removedOk = await waitForCondition(async () => bobRemoved.length >= 1);
  assert.equal(removedOk, true, "bob should observe channel.removed");
  const bobActive = await bob.bus.stores.channelStore.listChannels({ ownerAccountId: BOB, groupId: GROUP_ID });
  assert.equal(bobActive.length, 0);
  const bobAll = await bob.bus.stores.channelStore.listChannels({ ownerAccountId: BOB, groupId: GROUP_ID, includeDeleted: true });
  assert.equal(bobAll.length, 1, "tombstone retained for historical message resolution");

  // #general is undeletable at the slug-validation layer (empty string is the
  // implicit general bucket and would fail the channelId validator).
  await assert.rejects(() =>
    alice.bus.services.channels.deleteChannel({ groupId: GROUP_ID, channelId: "" }));
});
