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
const GROUP_ID = "grp_propagation_test";

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

async function seedGroup({ storage, ownerAccountId, groupId, title, members, clock }) {
  const groupStore = new GroupStore({ storageProvider: storage, clock });
  await groupStore.ensureGroup({
    ownerAccountId,
    groupId,
    createdBy: ownerAccountId,
    title,
  });
  for (const m of members) {
    await groupStore.ensureMembership({
      ownerAccountId,
      groupId,
      accountId: m.accountId,
      role: m.role || "member",
    });
  }
  // Seed the group thread so emitGroupUpdated paths don't fail
  const threadKv = storage.getKeyValueStore(ownerAccountId);
  const threadId = "th_" + groupId;
  await threadKv.set("app:threads/" + ownerAccountId + "/" + threadId, {
    threadId,
    threadType: "group",
    groupId,
    title,
    createdAtMs: 1000,
    updatedAtMs: 1000,
  });
}

function decodePayload(bytes) {
  return JSON.parse(new TextDecoder().decode(bytes));
}

test("rename fans out a rez.group-op.v1 rename payload to other active members", async () => {
  const storage = new TestStorageProvider();
  const sent = [];
  let now = 1000;
  const clock = () => (now += 100);

  await seedGroup({
    storage,
    ownerAccountId: ALICE,
    groupId: GROUP_ID,
    title: "Original",
    members: [
      { accountId: ALICE, role: "admin" },
      { accountId: BOB, role: "member" },
      { accountId: CARLA, role: "member" },
    ],
    clock: () => 1000,
  });

  const server = makeServer({ ownerAccountId: ALICE, storage, sendCapture: sent, clock });

  await server.bus.services.groups.renameGroup({ groupId: GROUP_ID, title: "Renamed" });

  assert.equal(sent.length, 2, "fan-out to bob and carla");
  const targets = sent.map((s) => s.peerAccountId).sort();
  assert.deepEqual(targets, [BOB, CARLA].sort());
  for (const entry of sent) {
    const payload = decodePayload(entry.plaintextBodyBytes);
    assert.equal(payload.kind, GROUP_OP_KIND);
    assert.equal(payload.op, "rename");
    assert.equal(payload.groupId, GROUP_ID);
    assert.equal(payload.title, "Renamed");
    assert.ok(typeof payload.groupOpId === "string" && payload.groupOpId.length > 0);
    assert.ok(Number.isFinite(payload.actedAtMs) && payload.actedAtMs > 0);
  }
});

test("kick fans out to all peers including the kicked member", async () => {
  const storage = new TestStorageProvider();
  const sent = [];
  let now = 1000;
  const clock = () => (now += 100);

  await seedGroup({
    storage,
    ownerAccountId: ALICE,
    groupId: GROUP_ID,
    title: "Group",
    members: [
      { accountId: ALICE, role: "admin" },
      { accountId: BOB, role: "member" },
      { accountId: CARLA, role: "member" },
    ],
    clock: () => 1000,
  });

  const server = makeServer({ ownerAccountId: ALICE, storage, sendCapture: sent, clock });

  await server.bus.services.groups.kickMember({ groupId: GROUP_ID, accountId: BOB });

  assert.equal(sent.length, 2, "fan-out to carla and to kicked bob");
  const targets = sent.map((s) => s.peerAccountId).sort();
  assert.deepEqual(targets, [BOB, CARLA].sort());
  for (const entry of sent) {
    const payload = decodePayload(entry.plaintextBodyBytes);
    assert.equal(payload.op, "kick");
    assert.equal(payload.accountId, BOB);
  }
});

test("setRole fans out a setRole payload", async () => {
  const storage = new TestStorageProvider();
  const sent = [];
  let now = 1000;
  const clock = () => (now += 100);

  await seedGroup({
    storage,
    ownerAccountId: ALICE,
    groupId: GROUP_ID,
    title: "Group",
    members: [
      { accountId: ALICE, role: "admin" },
      { accountId: BOB, role: "member" },
    ],
    clock: () => 1000,
  });

  const server = makeServer({ ownerAccountId: ALICE, storage, sendCapture: sent, clock });

  await server.bus.services.groups.setMemberRole({
    groupId: GROUP_ID,
    accountId: BOB,
    role: "admin",
  });

  assert.equal(sent.length, 1);
  const payload = decodePayload(sent[0].plaintextBodyBytes);
  assert.equal(payload.op, "setRole");
  assert.equal(payload.accountId, BOB);
  assert.equal(payload.role, "admin");
});

test("leave fans out a leave payload from the leaving member", async () => {
  const storage = new TestStorageProvider();
  const sent = [];
  let now = 1000;
  const clock = () => (now += 100);

  await seedGroup({
    storage,
    ownerAccountId: ALICE,
    groupId: GROUP_ID,
    title: "Group",
    members: [
      { accountId: ALICE, role: "member" },
      { accountId: BOB, role: "admin" },
      { accountId: CARLA, role: "member" },
    ],
    clock: () => 1000,
  });

  const server = makeServer({ ownerAccountId: ALICE, storage, sendCapture: sent, clock });

  await server.bus.services.groups.leaveGroup({ groupId: GROUP_ID });

  assert.equal(sent.length, 2);
  const targets = sent.map((s) => s.peerAccountId).sort();
  assert.deepEqual(targets, [BOB, CARLA].sort());
  for (const entry of sent) {
    const payload = decodePayload(entry.plaintextBodyBytes);
    assert.equal(payload.op, "leave");
    assert.equal(payload.accountId, ALICE);
  }
});

test("incoming rename op updates the receiver's local group title", async () => {
  const storage = new TestStorageProvider();
  let now = 1000;
  const clock = () => (now += 100);

  await seedGroup({
    storage,
    ownerAccountId: BOB,
    groupId: GROUP_ID,
    title: "Stale",
    members: [
      { accountId: BOB, role: "member" },
      { accountId: ALICE, role: "admin" },
    ],
    clock: () => 1000,
  });

  const server = makeServer({ ownerAccountId: BOB, storage, sendCapture: null, clock });

  let groupUpdatedReceived = null;
  server.bus.on("group.updated", (record) => { groupUpdatedReceived = record; });

  const consumed = await server.bus.services.groups.handleIncomingGroupOp(new GroupOpPayloadV1({
    op: "rename",
    groupId: GROUP_ID,
    title: "Renamed By Alice",
    actedAtMs: 9999,
    groupOpId: "gop_test_rename",
  }), { senderAccountId: ALICE });

  assert.equal(consumed, true);
  assert.ok(groupUpdatedReceived, "group.updated emitted");
  assert.equal(groupUpdatedReceived.group.title, "Renamed By Alice");

  const groupStore = new GroupStore({ storageProvider: storage, clock: () => 1000 });
  const group = await groupStore.getGroup({ ownerAccountId: BOB, groupId: GROUP_ID });
  assert.equal(group.title, "Renamed By Alice");
});

test("incoming kick op from admin removes the kicked member locally", async () => {
  const storage = new TestStorageProvider();
  let now = 1000;
  const clock = () => (now += 100);

  await seedGroup({
    storage,
    ownerAccountId: BOB,
    groupId: GROUP_ID,
    title: "Group",
    members: [
      { accountId: BOB, role: "member" },
      { accountId: ALICE, role: "admin" },
      { accountId: CARLA, role: "member" },
    ],
    clock: () => 1000,
  });

  const server = makeServer({ ownerAccountId: BOB, storage, sendCapture: null, clock });

  const consumed = await server.bus.services.groups.handleIncomingGroupOp(new GroupOpPayloadV1({
    op: "kick",
    groupId: GROUP_ID,
    accountId: CARLA,
    actedAtMs: 9999,
    groupOpId: "gop_test_kick",
  }), { senderAccountId: ALICE });

  assert.equal(consumed, true);

  const groupStore = new GroupStore({ storageProvider: storage, clock: () => 1000 });
  const members = await groupStore.listMembers({ ownerAccountId: BOB, groupId: GROUP_ID });
  const carla = members.find((m) => m.accountId === CARLA);
  assert.ok(!carla || carla.state !== "active", "carla should no longer be active in bob's view");
});

test("incoming kick op from non-admin is rejected", async () => {
  const storage = new TestStorageProvider();
  let now = 1000;
  const clock = () => (now += 100);

  await seedGroup({
    storage,
    ownerAccountId: BOB,
    groupId: GROUP_ID,
    title: "Group",
    members: [
      { accountId: BOB, role: "admin" },
      { accountId: ALICE, role: "member" }, // alice is NOT admin
      { accountId: CARLA, role: "member" },
    ],
    clock: () => 1000,
  });

  const server = makeServer({ ownerAccountId: BOB, storage, sendCapture: null, clock });

  const consumed = await server.bus.services.groups.handleIncomingGroupOp(new GroupOpPayloadV1({
    op: "kick",
    groupId: GROUP_ID,
    accountId: CARLA,
    actedAtMs: 9999,
    groupOpId: "gop_test_unauthorized_kick",
  }), { senderAccountId: ALICE });

  assert.equal(consumed, true, "still consumed (not retried)");

  const groupStore = new GroupStore({ storageProvider: storage, clock: () => 1000 });
  const members = await groupStore.listMembers({ ownerAccountId: BOB, groupId: GROUP_ID });
  const carla = members.find((m) => m.accountId === CARLA);
  assert.equal(carla && carla.state, "active", "carla still active — non-admin kick rejected");
});

test("incoming leave op for self removes the leaver locally", async () => {
  const storage = new TestStorageProvider();
  let now = 1000;
  const clock = () => (now += 100);

  await seedGroup({
    storage,
    ownerAccountId: BOB,
    groupId: GROUP_ID,
    title: "Group",
    members: [
      { accountId: BOB, role: "admin" },
      { accountId: ALICE, role: "member" },
    ],
    clock: () => 1000,
  });

  const server = makeServer({ ownerAccountId: BOB, storage, sendCapture: null, clock });

  const consumed = await server.bus.services.groups.handleIncomingGroupOp(new GroupOpPayloadV1({
    op: "leave",
    groupId: GROUP_ID,
    accountId: ALICE,
    actedAtMs: 9999,
    groupOpId: "gop_test_leave",
  }), { senderAccountId: ALICE });

  assert.equal(consumed, true);

  const groupStore = new GroupStore({ storageProvider: storage, clock: () => 1000 });
  const members = await groupStore.listMembers({ ownerAccountId: BOB, groupId: GROUP_ID });
  const alice = members.find((m) => m.accountId === ALICE);
  assert.ok(!alice || alice.state !== "active", "alice should no longer be active in bob's view");
});

test("incoming op from non-member is rejected", async () => {
  const storage = new TestStorageProvider();
  let now = 1000;
  const clock = () => (now += 100);

  await seedGroup({
    storage,
    ownerAccountId: BOB,
    groupId: GROUP_ID,
    title: "Original",
    members: [
      { accountId: BOB, role: "admin" },
    ],
    clock: () => 1000,
  });

  const server = makeServer({ ownerAccountId: BOB, storage, sendCapture: null, clock });

  const consumed = await server.bus.services.groups.handleIncomingGroupOp(new GroupOpPayloadV1({
    op: "rename",
    groupId: GROUP_ID,
    title: "Should Not Apply",
    actedAtMs: 9999,
    groupOpId: "gop_test_outsider",
  }), { senderAccountId: ALICE });

  assert.equal(consumed, true);

  const groupStore = new GroupStore({ storageProvider: storage, clock: () => 1000 });
  const group = await groupStore.getGroup({ ownerAccountId: BOB, groupId: GROUP_ID });
  assert.equal(group.title, "Original", "title unchanged because alice is not a member");
});

test("malformed payloads are discarded but consumed", async () => {
  const storage = new TestStorageProvider();
  let now = 1000;
  const clock = () => (now += 100);

  await seedGroup({
    storage,
    ownerAccountId: BOB,
    groupId: GROUP_ID,
    title: "Original",
    members: [
      { accountId: BOB, role: "admin" },
      { accountId: ALICE, role: "admin" },
    ],
    clock: () => 1000,
  });

  const server = makeServer({ ownerAccountId: BOB, storage, sendCapture: null, clock });

  // After Phase 4.D, malformed payloads can't reach the handler — the
  // payload-kind registry constructs a GroupOpPayloadV1 at the receive
  // boundary (in ServerEventService) and throws on validation failure
  // before dispatch. The handler now only accepts validated records.
  // Verify that contract: non-record input returns false (not consumed).
  const consumed = await server.bus.services.groups.handleIncomingGroupOp({
    kind: GROUP_OP_KIND,
    op: "rename",
    // missing required fields
  }, { senderAccountId: ALICE });

  assert.equal(consumed, false, "non-record input is not consumed");

  // And constructing the record from the malformed input throws:
  assert.throws(() => new GroupOpPayloadV1({
    op: "rename",
    // missing required fields
  }), "GroupOpPayloadV1 validates required fields on construction");

  const groupStore = new GroupStore({ storageProvider: storage, clock: () => 1000 });
  const group = await groupStore.getGroup({ ownerAccountId: BOB, groupId: GROUP_ID });
  assert.equal(group.title, "Original");
});
