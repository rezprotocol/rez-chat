import test from "node:test";
import assert from "node:assert/strict";
import { ChatServerApp } from "../src/server/app/ChatServerApp.js";
import { GroupStore } from "../src/server/storage/ChatGroupStore.js";
import { GROUP_OP_KIND, GroupOpPayloadV1 } from "../src/records/payloads/GroupOpPayloadV1.js";

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
const CARLA = "rez:acct:carla";
const GROUP_ID = "grp_channels_test";

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

async function seedGroup({ storage, ownerAccountId, groupId, title, members, clock, createdBy }) {
  const groupStore = new GroupStore({ storageProvider: storage, clock });
  // Founder = group.createdBy is the implicit admin (single source of truth
  // for the founder-admin rule). Tests that want owner-as-non-admin must
  // pass an explicit `createdBy` other than ownerAccountId.
  await groupStore.ensureGroup({
    ownerAccountId, groupId, createdBy: createdBy || ownerAccountId, title,
  });
  for (const m of members) {
    await groupStore.ensureMembership({
      ownerAccountId, groupId, accountId: m.accountId, role: m.role || "member",
    });
  }
}

function decodePayload(bytes) {
  return JSON.parse(new TextDecoder().decode(bytes));
}

function captureEvents(bus, eventName) {
  const events = [];
  bus.on(eventName, (payload) => events.push(payload));
  return events;
}

test("channels.create persists the channel, emits channel.upserted, fans out channel.create to peers", async () => {
  const storage = new TestStorageProvider();
  const sent = [];
  let now = 1000;
  const clock = () => (now += 100);

  await seedGroup({
    storage, ownerAccountId: ALICE, groupId: GROUP_ID, title: "Test",
    members: [
      { accountId: ALICE, role: "admin" },
      { accountId: BOB, role: "member" },
      { accountId: CARLA, role: "member" },
    ],
    clock: () => 1000,
  });

  const server = makeServer({ ownerAccountId: ALICE, storage, sendCapture: sent, clock });
  const upserted = captureEvents(server.bus, "channel.upserted");

  const result = await server.bus.services.channels.createChannel({
    groupId: GROUP_ID, channelId: "dev",
  });
  assert.equal(result.created, true);
  assert.equal(result.channel.channelId, "dev");

  assert.equal(upserted.length, 1);
  assert.equal(upserted[0].channel.channelId, "dev");

  assert.equal(sent.length, 2, "fan-out to bob and carla");
  const targets = sent.map((s) => s.peerAccountId).sort();
  assert.deepEqual(targets, [BOB, CARLA].sort());
  for (const entry of sent) {
    const payload = decodePayload(entry.plaintextBodyBytes);
    assert.equal(payload.kind, GROUP_OP_KIND);
    assert.equal(payload.op, "channel.create");
    assert.equal(payload.groupId, GROUP_ID);
    assert.equal(payload.channelId, "dev");
  }
});

test("channels.create is idempotent and does not re-fanout on duplicate", async () => {
  const storage = new TestStorageProvider();
  const sent = [];
  let now = 1000;
  const clock = () => (now += 100);

  await seedGroup({
    storage, ownerAccountId: ALICE, groupId: GROUP_ID, title: "Test",
    members: [{ accountId: ALICE, role: "admin" }, { accountId: BOB, role: "member" }],
    clock: () => 1000,
  });

  const server = makeServer({ ownerAccountId: ALICE, storage, sendCapture: sent, clock });
  await server.bus.services.channels.createChannel({ groupId: GROUP_ID, channelId: "dev" });
  const sentAfterFirst = sent.length;

  const second = await server.bus.services.channels.createChannel({
    groupId: GROUP_ID, channelId: "dev",
  });
  assert.equal(second.created, false);
  assert.equal(sent.length, sentAfterFirst, "no extra fan-out on idempotent create");
});

test("channels.create rejects callers who are not active group members", async () => {
  const storage = new TestStorageProvider();
  let now = 1000;
  const clock = () => (now += 100);
  await seedGroup({
    storage, ownerAccountId: ALICE, groupId: GROUP_ID, title: "Test",
    members: [{ accountId: BOB, role: "member" }],  // Alice not a member
    clock: () => 1000,
  });
  const server = makeServer({ ownerAccountId: ALICE, storage, sendCapture: [], clock });
  await assert.rejects(() =>
    server.bus.services.channels.createChannel({ groupId: GROUP_ID, channelId: "dev" }));
});

test("channels.create slugifies a free-form label and preserves it for display", async () => {
  const storage = new TestStorageProvider();
  const sent = [];
  let now = 1000;
  const clock = () => (now += 100);
  await seedGroup({
    storage, ownerAccountId: ALICE, groupId: GROUP_ID, title: "Test",
    members: [{ accountId: ALICE, role: "admin" }, { accountId: BOB, role: "member" }],
    clock: () => 1000,
  });
  const server = makeServer({ ownerAccountId: ALICE, storage, sendCapture: sent, clock });
  const result = await server.bus.services.channels.createChannel({
    groupId: GROUP_ID, label: "Dev Chat",
  });
  assert.equal(result.created, true);
  assert.equal(result.channel.channelId, "dev-chat", "label slugified into channelId");
  assert.equal(result.channel.label, "Dev Chat", "original label preserved on the record");
  // Fan-out carries label so peers display it without their own slugification.
  assert.equal(sent.length, 1);
  const payload = decodePayload(sent[0].plaintextBodyBytes);
  assert.equal(payload.op, "channel.create");
  assert.equal(payload.channelId, "dev-chat");
  assert.equal(payload.label, "Dev Chat");
});

test("requestSyncForAllMyGroups sends a channels.sync_request op to every active peer in each of my groups", async () => {
  const storage = new TestStorageProvider();
  const sent = [];
  let now = 1000;
  const clock = () => (now += 100);
  // Two groups, both with Alice + Bob + Carla. Alice owns the server.
  await seedGroup({
    storage, ownerAccountId: ALICE, groupId: "grp_one", title: "One",
    members: [
      { accountId: ALICE, role: "admin" },
      { accountId: BOB, role: "member" },
      { accountId: CARLA, role: "member" },
    ],
    clock: () => 1000,
  });
  await seedGroup({
    storage, ownerAccountId: ALICE, groupId: "grp_two", title: "Two",
    members: [
      { accountId: ALICE, role: "admin" },
      { accountId: BOB, role: "member" },
    ],
    clock: () => 1000,
  });
  const server = makeServer({ ownerAccountId: ALICE, storage, sendCapture: sent, clock });

  await server.bus.services.channels.requestSyncForAllMyGroups();

  // Expect: grp_one → bob, carla (2 ops); grp_two → bob (1 op) = 3 ops.
  assert.equal(sent.length, 3);
  const byGroup = new Map();
  for (const entry of sent) {
    const payload = decodePayload(entry.plaintextBodyBytes);
    assert.equal(payload.kind, GROUP_OP_KIND);
    assert.equal(payload.op, "channels.sync_request");
    const arr = byGroup.get(payload.groupId) || [];
    arr.push(entry.peerAccountId);
    byGroup.set(payload.groupId, arr);
  }
  assert.deepEqual([...(byGroup.get("grp_one") || [])].sort(), [BOB, CARLA].sort());
  assert.deepEqual([...(byGroup.get("grp_two") || [])].sort(), [BOB]);
});

test("runtime.connected triggers channels.sync_request fan-out", async () => {
  const storage = new TestStorageProvider();
  const sent = [];
  let now = 1000;
  const clock = () => (now += 100);
  await seedGroup({
    storage, ownerAccountId: ALICE, groupId: GROUP_ID, title: "Test",
    members: [{ accountId: ALICE, role: "admin" }, { accountId: BOB, role: "member" }],
    clock: () => 1000,
  });
  const server = makeServer({ ownerAccountId: ALICE, storage, sendCapture: sent, clock });

  server.bus.emit("runtime.connected", { status: "connected" });
  // Listener fires the async sync without awaiting; flush microtasks until
  // the fan-out has had a chance to land.
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(sent.length, 1);
  const payload = decodePayload(sent[0].plaintextBodyBytes);
  assert.equal(payload.op, "channels.sync_request");
  assert.equal(payload.groupId, GROUP_ID);
  assert.equal(sent[0].peerAccountId, BOB);
});

test("responding to channels.sync_request also sends a group.state op carrying the current title", async () => {
  const storage = new TestStorageProvider();
  const sent = [];
  let now = 1000;
  const clock = () => (now += 100);
  await seedGroup({
    storage, ownerAccountId: ALICE, groupId: GROUP_ID, title: "Project Phoenix",
    members: [{ accountId: ALICE, role: "admin" }, { accountId: BOB, role: "member" }],
    clock: () => 1000,
  });
  const server = makeServer({ ownerAccountId: ALICE, storage, sendCapture: sent, clock });

  await server.bus.services.groups.handleIncomingGroupOp(new GroupOpPayloadV1({
    op: "channels.sync_request",
    groupId: GROUP_ID,
    actedAtMs: 9999,
    groupOpId: "gop_test_syncreq",
  }), { senderAccountId: BOB });

  const ops = sent.map((s) => decodePayload(s.plaintextBodyBytes));
  const state = ops.find((p) => p.op === "group.state");
  assert.ok(state, "group.state op emitted in response to sync_request");
  assert.equal(state.groupId, GROUP_ID);
  assert.equal(state.title, "Project Phoenix");
  assert.equal(sent.find((s) => decodePayload(s.plaintextBodyBytes).op === "group.state").peerAccountId, BOB);
  // Distinct from rename: rename is a user-initiated mutation; this is catch-up advertisement.
  assert.ok(!ops.find((p) => p.op === "rename"), "no synthesized rename op");
});

test("incoming group.state op fills an empty local title", async () => {
  const storage = new TestStorageProvider();
  let now = 1000;
  const clock = () => (now += 100);
  const groupStore = new GroupStore({ storageProvider: storage, clock: () => 5000 });
  await groupStore.ensureGroup({ ownerAccountId: BOB, groupId: GROUP_ID, createdBy: BOB, title: "" });
  await groupStore.ensureMembership({ ownerAccountId: BOB, groupId: GROUP_ID, accountId: BOB, role: "member" });
  await groupStore.ensureMembership({ ownerAccountId: BOB, groupId: GROUP_ID, accountId: ALICE, role: "admin" });

  const server = makeServer({ ownerAccountId: BOB, storage, sendCapture: null, clock });

  const consumed = await server.bus.services.groups.handleIncomingGroupOp(new GroupOpPayloadV1({
    op: "group.state",
    groupId: GROUP_ID,
    title: "Project Phoenix",
    actedAtMs: 1,
    groupOpId: "gop_test_fill",
  }), { senderAccountId: ALICE });

  assert.equal(consumed, true);
  const stored = await groupStore.getGroup({ ownerAccountId: BOB, groupId: GROUP_ID });
  assert.equal(stored.title, "Project Phoenix");
});

test("incoming group.state op does NOT overwrite a non-empty local title", async () => {
  const storage = new TestStorageProvider();
  let now = 1000;
  const clock = () => (now += 100);
  const groupStore = new GroupStore({ storageProvider: storage, clock: () => 5000 });
  await groupStore.ensureGroup({ ownerAccountId: BOB, groupId: GROUP_ID, createdBy: BOB, title: "Bob's Title" });
  await groupStore.ensureMembership({ ownerAccountId: BOB, groupId: GROUP_ID, accountId: BOB, role: "member" });
  await groupStore.ensureMembership({ ownerAccountId: BOB, groupId: GROUP_ID, accountId: ALICE, role: "admin" });

  const server = makeServer({ ownerAccountId: BOB, storage, sendCapture: null, clock });

  await server.bus.services.groups.handleIncomingGroupOp(new GroupOpPayloadV1({
    op: "group.state",
    groupId: GROUP_ID,
    title: "Alice Override",
    actedAtMs: 999999,
    groupOpId: "gop_test_no_overwrite",
  }), { senderAccountId: ALICE });

  const stored = await groupStore.getGroup({ ownerAccountId: BOB, groupId: GROUP_ID });
  assert.equal(stored.title, "Bob's Title", "non-empty local title preserved");
});

test("incoming rename op with stale actedAtMs is dropped (strict LWW)", async () => {
  const storage = new TestStorageProvider();
  let now = 1000;
  const clock = () => (now += 100);
  const groupStore = new GroupStore({ storageProvider: storage, clock: () => 5000 });
  await groupStore.ensureGroup({ ownerAccountId: BOB, groupId: GROUP_ID, createdBy: BOB, title: "" });
  await groupStore.ensureMembership({ ownerAccountId: BOB, groupId: GROUP_ID, accountId: BOB, role: "member" });
  await groupStore.ensureMembership({ ownerAccountId: BOB, groupId: GROUP_ID, accountId: ALICE, role: "admin" });

  const server = makeServer({ ownerAccountId: BOB, storage, sendCapture: null, clock });

  await server.bus.services.groups.handleIncomingGroupOp(new GroupOpPayloadV1({
    op: "rename",
    groupId: GROUP_ID,
    title: "Project Phoenix",
    actedAtMs: 1,
    groupOpId: "gop_test_stale_rename",
  }), { senderAccountId: ALICE });

  const stored = await groupStore.getGroup({ ownerAccountId: BOB, groupId: GROUP_ID });
  assert.equal(stored.title, "", "stale rename rejected by LWW");
});

test("channels.create rejects labels with no slug-able characters", async () => {
  const storage = new TestStorageProvider();
  let now = 1000;
  const clock = () => (now += 100);
  await seedGroup({
    storage, ownerAccountId: ALICE, groupId: GROUP_ID, title: "Test",
    members: [{ accountId: ALICE, role: "admin" }],
    clock: () => 1000,
  });
  const server = makeServer({ ownerAccountId: ALICE, storage, sendCapture: [], clock });
  await assert.rejects(() =>
    server.bus.services.channels.createChannel({ groupId: GROUP_ID, label: "###" }));
});

test("channels.delete tombstones the channel, emits channel.removed, fans out channel.delete; admin only", async () => {
  const storage = new TestStorageProvider();
  const sent = [];
  let now = 1000;
  const clock = () => (now += 100);

  await seedGroup({
    storage, ownerAccountId: ALICE, groupId: GROUP_ID, title: "Test",
    members: [
      { accountId: ALICE, role: "admin" },
      { accountId: BOB, role: "member" },
    ],
    clock: () => 1000,
  });

  const server = makeServer({ ownerAccountId: ALICE, storage, sendCapture: sent, clock });
  await server.bus.services.channels.createChannel({ groupId: GROUP_ID, channelId: "dev" });
  sent.length = 0;
  const removed = captureEvents(server.bus, "channel.removed");

  const result = await server.bus.services.channels.deleteChannel({
    groupId: GROUP_ID, channelId: "dev",
  });
  assert.equal(result.deleted, true);
  assert.equal(removed.length, 1);
  assert.equal(removed[0].channelId, "dev");

  assert.equal(sent.length, 1);
  const payload = decodePayload(sent[0].plaintextBodyBytes);
  assert.equal(payload.op, "channel.delete");
  assert.equal(payload.channelId, "dev");
});

test("channels.delete rejects non-admin callers", async () => {
  const storage = new TestStorageProvider();
  let now = 1000;
  const clock = () => (now += 100);
  await seedGroup({
    storage, ownerAccountId: ALICE, groupId: GROUP_ID, title: "Test",
    // Bob founded the group; Alice is a regular member.
    createdBy: BOB,
    members: [{ accountId: ALICE, role: "member" }, { accountId: BOB, role: "admin" }],
    clock: () => 1000,
  });
  const server = makeServer({ ownerAccountId: ALICE, storage, sendCapture: [], clock });
  // seed a channel directly so deleteChannel finds something to delete
  await server.bus.stores.channelStore.ensureChannel({
    ownerAccountId: ALICE, groupId: GROUP_ID, channelId: "dev",
  });
  await assert.rejects(
    () => server.bus.services.channels.deleteChannel({ groupId: GROUP_ID, channelId: "dev" }),
    (err) => err && err.code === "ADMIN_REQUIRED",
  );
});

test("channels.create rejects non-admin callers with ADMIN_REQUIRED", async () => {
  const storage = new TestStorageProvider();
  let now = 1000;
  const clock = () => (now += 100);
  await seedGroup({
    storage, ownerAccountId: ALICE, groupId: GROUP_ID, title: "Test",
    // Bob founded the group; Alice is a regular member.
    createdBy: BOB,
    members: [{ accountId: ALICE, role: "member" }, { accountId: BOB, role: "admin" }],
    clock: () => 1000,
  });
  const server = makeServer({ ownerAccountId: ALICE, storage, sendCapture: [], clock });
  await assert.rejects(
    () => server.bus.services.channels.createChannel({ groupId: GROUP_ID, channelId: "dev" }),
    (err) => err && err.code === "ADMIN_REQUIRED",
  );
});

test("inbound channel.create op (via GroupsService routing) materializes channel and emits channel.upserted on receiver", async () => {
  const storage = new TestStorageProvider();
  let now = 1000;
  const clock = () => (now += 100);

  // Bob is the local owner; Alice is a peer admin who created the channel.
  await seedGroup({
    storage, ownerAccountId: BOB, groupId: GROUP_ID, title: "Test",
    members: [
      { accountId: BOB, role: "member" },
      { accountId: ALICE, role: "admin" },
    ],
    clock: () => 1000,
  });

  const server = makeServer({ ownerAccountId: BOB, storage, sendCapture: [], clock });
  const upserted = captureEvents(server.bus, "channel.upserted");

  const op = new GroupOpPayloadV1({
    op: "channel.create",
    groupId: GROUP_ID,
    channelId: "dev",
    actedAtMs: 2000,
    groupOpId: "gop_test_1",
  });
  await server.bus.services.groups.handleIncomingGroupOp(op, { senderAccountId: ALICE });

  assert.equal(upserted.length, 1);
  assert.equal(upserted[0].channel.channelId, "dev");

  const stored = await server.bus.stores.channelStore.listChannels({
    ownerAccountId: BOB, groupId: GROUP_ID,
  });
  assert.equal(stored.length, 1);
  assert.equal(stored[0].channelId, "dev");
});

test("inbound channel.delete op from admin tombstones; from non-admin is ignored", async () => {
  const storage = new TestStorageProvider();
  let now = 1000;
  const clock = () => (now += 100);
  await seedGroup({
    storage, ownerAccountId: BOB, groupId: GROUP_ID, title: "Test",
    members: [
      { accountId: BOB, role: "member" },
      { accountId: ALICE, role: "admin" },
      { accountId: CARLA, role: "member" },
    ],
    clock: () => 1000,
  });

  const server = makeServer({ ownerAccountId: BOB, storage, sendCapture: [], clock });
  await server.bus.stores.channelStore.ensureChannel({
    ownerAccountId: BOB, groupId: GROUP_ID, channelId: "dev",
  });
  const removed = captureEvents(server.bus, "channel.removed");

  // Non-admin Carla cannot delete
  const opFromCarla = new GroupOpPayloadV1({
    op: "channel.delete", groupId: GROUP_ID, channelId: "dev",
    actedAtMs: 2000, groupOpId: "gop_carla",
  });
  await server.bus.services.groups.handleIncomingGroupOp(opFromCarla, { senderAccountId: CARLA });
  assert.equal(removed.length, 0);
  let stored = await server.bus.stores.channelStore.listChannels({ ownerAccountId: BOB, groupId: GROUP_ID });
  assert.equal(stored.length, 1, "non-admin delete was ignored");

  // Admin Alice can delete
  const opFromAlice = new GroupOpPayloadV1({
    op: "channel.delete", groupId: GROUP_ID, channelId: "dev",
    actedAtMs: 2000, groupOpId: "gop_alice",
  });
  await server.bus.services.groups.handleIncomingGroupOp(opFromAlice, { senderAccountId: ALICE });
  assert.equal(removed.length, 1);
  stored = await server.bus.stores.channelStore.listChannels({ ownerAccountId: BOB, groupId: GROUP_ID });
  assert.equal(stored.length, 0, "admin delete tombstoned the channel");
});

test("ensureFromObservedMessage materializes channel record on first observation only", async () => {
  const storage = new TestStorageProvider();
  let now = 1000;
  const clock = () => (now += 100);
  await seedGroup({
    storage, ownerAccountId: BOB, groupId: GROUP_ID, title: "Test",
    members: [{ accountId: BOB, role: "member" }],
    clock: () => 1000,
  });

  const server = makeServer({ ownerAccountId: BOB, storage, sendCapture: [], clock });
  const upserted = captureEvents(server.bus, "channel.upserted");

  await server.bus.services.channels.ensureFromObservedMessage({
    groupId: GROUP_ID, channelId: "dev",
  });
  await server.bus.services.channels.ensureFromObservedMessage({
    groupId: GROUP_ID, channelId: "dev",
  });

  assert.equal(upserted.length, 1, "only the first observation emits");
});

test("ensureFromObservedMessage silently ignores invalid/empty channelId", async () => {
  const storage = new TestStorageProvider();
  let now = 1000;
  const clock = () => (now += 100);
  await seedGroup({
    storage, ownerAccountId: BOB, groupId: GROUP_ID, title: "Test",
    members: [{ accountId: BOB, role: "member" }],
    clock: () => 1000,
  });

  const server = makeServer({ ownerAccountId: BOB, storage, sendCapture: [], clock });
  const upserted = captureEvents(server.bus, "channel.upserted");

  await server.bus.services.channels.ensureFromObservedMessage({ groupId: GROUP_ID, channelId: "" });
  await server.bus.services.channels.ensureFromObservedMessage({ groupId: GROUP_ID, channelId: "Bad Name" });
  await server.bus.services.channels.ensureFromObservedMessage({ groupId: GROUP_ID });

  assert.equal(upserted.length, 0);
});

test("messages.send threads channelId through onto ChatMessagePayloadV1 wire payload", async () => {
  const storage = new TestStorageProvider();
  let now = 1000;
  const clock = () => (now += 100);
  await seedGroup({
    storage, ownerAccountId: ALICE, groupId: GROUP_ID, title: "Test",
    members: [{ accountId: ALICE, role: "admin" }],
    clock: () => 1000,
  });
  const server = makeServer({ ownerAccountId: ALICE, storage, sendCapture: [], clock });

  // Need a thread that messages.send recognizes. The group's derived threadId works.
  const threadId = server.bus.services.threads.groupThreadId(GROUP_ID);
  // ensureThread so the message-send path can record against it
  await server.bus.stores.threadStore.ensureThread({
    threadId, groupId: GROUP_ID, threadType: "group", title: "Test",
  });

  const deposited = captureEvents(server.bus, "message.deposited");
  await server.bus.services.messages.sendMessage({
    threadId,
    payload: { kind: "rez.chat.message.v1", text: "hi dev channel" },
    channelId: "dev",
  });

  assert.equal(deposited.length, 1);
  const wirePayload = deposited[0].message.payload;
  assert.equal(wirePayload.channelId, "dev");
  assert.equal(wirePayload.text, "hi dev channel");
});

test("messages.send with no channelId leaves channelId absent (= implicit #general)", async () => {
  const storage = new TestStorageProvider();
  let now = 1000;
  const clock = () => (now += 100);
  await seedGroup({
    storage, ownerAccountId: ALICE, groupId: GROUP_ID, title: "Test",
    members: [{ accountId: ALICE, role: "admin" }],
    clock: () => 1000,
  });
  const server = makeServer({ ownerAccountId: ALICE, storage, sendCapture: [], clock });
  const threadId = server.bus.services.threads.groupThreadId(GROUP_ID);
  await server.bus.stores.threadStore.ensureThread({
    threadId, groupId: GROUP_ID, threadType: "group", title: "Test",
  });

  const deposited = captureEvents(server.bus, "message.deposited");
  await server.bus.services.messages.sendMessage({
    threadId,
    payload: { kind: "rez.chat.message.v1", text: "hi general" },
  });
  assert.equal(deposited.length, 1);
  const wirePayload = deposited[0].message.payload;
  // Either absent or empty string — both render as #general
  const ch = wirePayload.channelId == null ? "" : String(wirePayload.channelId);
  assert.equal(ch, "");
});

test("channels.list returns channels for owner+group, excluding tombstones by default", async () => {
  const storage = new TestStorageProvider();
  let now = 1000;
  const clock = () => (now += 100);
  await seedGroup({
    storage, ownerAccountId: ALICE, groupId: GROUP_ID, title: "Test",
    members: [{ accountId: ALICE, role: "admin" }],
    clock: () => 1000,
  });

  const server = makeServer({ ownerAccountId: ALICE, storage, sendCapture: [], clock });
  await server.bus.services.channels.createChannel({ groupId: GROUP_ID, channelId: "dev" });
  await server.bus.services.channels.createChannel({ groupId: GROUP_ID, channelId: "ops" });
  await server.bus.services.channels.deleteChannel({ groupId: GROUP_ID, channelId: "dev" });

  const active = await server.bus.services.channels.listChannels({ groupId: GROUP_ID });
  assert.deepEqual(active.items.map((c) => c.channelId), ["ops"]);

  const all = await server.bus.services.channels.listChannels({ groupId: GROUP_ID, includeDeleted: true });
  assert.equal(all.items.length, 2);
});
