import test from "node:test";
import assert from "node:assert/strict";
import { ChatServerApp } from "../src/server/app/ChatServerApp.js";
import { GroupStore } from "../src/server/storage/ChatGroupStore.js";
import { GROUP_OP_KIND, GroupOpPayloadV1 } from "../src/records/payloads/GroupOpPayloadV1.js";
import { base64ToBytes, bytesToBase64 } from "@rezprotocol/sdk/client";
import { Hash } from "@rezprotocol/sdk/hash";
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
const CARLA = "rez:acct:carla";
const GROUP_ID = "grp_setavatar_test";

// A tiny stand-in for a JPEG — content is opaque to the avatar path, which only
// cares that the SHA-256 of the bytes matches the advertised hash.
const AVATAR_B64 = bytesToBase64(new TextEncoder().encode("fake-jpeg-bytes-for-test"));
const AVATAR_HASH = Hash.sha256Hex(base64ToBytes(AVATAR_B64));

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

async function seedGroup({ storage, ownerAccountId, groupId, title, members, clock, createdBy }) {
  const groupStore = new GroupStore({ storageProvider: storage, clock });
  await groupStore.ensureGroup({ ownerAccountId, groupId, createdBy: createdBy || ownerAccountId, title });
  for (const m of members) {
    await groupStore.ensureMembership({ ownerAccountId, groupId, accountId: m.accountId, role: m.role || "member" });
  }
  const threadKv = storage.getKeyValueStore(ownerAccountId);
  const threadId = "th_" + groupId;
  await threadKv.set("app:threads/" + ownerAccountId + "/" + threadId, {
    threadId, threadType: "group", groupId, title, createdAtMs: 1000, updatedAtMs: 1000,
  });
}

function decodePayload(bytes) {
  return JSON.parse(new TextDecoder().decode(bytes));
}

test("setAvatar stores the photo, emits group.updated, and fans out hash+bytes", async () => {
  const storage = new TestStorageProvider();
  const sent = [];
  let now = 1000;
  const clock = () => (now += 100);

  await seedGroup({
    storage, ownerAccountId: ALICE, groupId: GROUP_ID, title: "Group",
    members: [
      { accountId: ALICE, role: "admin" },
      { accountId: BOB, role: "member" },
      { accountId: CARLA, role: "member" },
    ],
    clock: () => 1000,
  });

  const server = makeServer({ ownerAccountId: ALICE, storage, sendCapture: sent, clock });

  let updated = null;
  server.bus.on("group.updated", (record) => { updated = record; });

  const result = await server.bus.services.groups.setAvatarGroup({ groupId: GROUP_ID, avatarDataB64: AVATAR_B64 });

  assert.equal(result.group.avatarFileHash, AVATAR_HASH);
  assert.ok(updated && updated.group.avatarFileHash === AVATAR_HASH, "group.updated carries the new hash");

  // Bytes are content-addressed in the file store.
  const stored = await server.bus.services.fileTransfer.retrieveFileB64(AVATAR_HASH);
  assert.equal(stored, AVATAR_B64);

  assert.equal(sent.length, 2, "fan-out to bob and carla");
  for (const entry of sent) {
    const payload = decodePayload(entry.plaintextBodyBytes);
    assert.equal(payload.kind, GROUP_OP_KIND);
    assert.equal(payload.op, "setAvatar");
    assert.equal(payload.groupId, GROUP_ID);
    assert.equal(payload.avatarFileHash, AVATAR_HASH);
    assert.equal(payload.avatarDataB64, AVATAR_B64, "bytes ride inline so the photo lands atomically");
  }
});

test("setAvatar with empty data clears the photo and fans out an empty hash", async () => {
  const storage = new TestStorageProvider();
  const sent = [];
  let now = 1000;
  const clock = () => (now += 100);

  await seedGroup({
    storage, ownerAccountId: ALICE, groupId: GROUP_ID, title: "Group",
    members: [
      { accountId: ALICE, role: "admin" },
      { accountId: BOB, role: "member" },
    ],
    clock: () => 1000,
  });

  const server = makeServer({ ownerAccountId: ALICE, storage, sendCapture: sent, clock });
  // First set a photo, then clear it.
  await server.bus.services.groups.setAvatarGroup({ groupId: GROUP_ID, avatarDataB64: AVATAR_B64 });
  sent.length = 0;

  const result = await server.bus.services.groups.setAvatarGroup({ groupId: GROUP_ID, avatarDataB64: "" });
  assert.equal(result.group.avatarFileHash, "");

  assert.equal(sent.length, 1);
  const payload = decodePayload(sent[0].plaintextBodyBytes);
  assert.equal(payload.op, "setAvatar");
  assert.equal(payload.avatarFileHash, "");
  assert.equal(payload.avatarDataB64, "");
});

test("setAvatar from a non-admin is rejected", async () => {
  const storage = new TestStorageProvider();
  const sent = [];
  let now = 1000;
  const clock = () => (now += 100);

  await seedGroup({
    storage, ownerAccountId: ALICE, groupId: GROUP_ID, title: "Group",
    createdBy: BOB, // BOB founded the group; ALICE is a plain member, not admin
    members: [
      { accountId: ALICE, role: "member" }, // self is NOT admin
      { accountId: BOB, role: "admin" },
    ],
    clock: () => 1000,
  });

  const server = makeServer({ ownerAccountId: ALICE, storage, sendCapture: sent, clock });
  await assert.rejects(
    () => server.bus.services.groups.setAvatarGroup({ groupId: GROUP_ID, avatarDataB64: AVATAR_B64 }),
    /admin/i,
  );
  assert.equal(sent.length, 0, "no fan-out on rejected set");
});

test("incoming setAvatar op stores bytes and updates the receiver's group", async () => {
  const storage = new TestStorageProvider();
  let now = 1000;
  const clock = () => (now += 100);

  await seedGroup({
    storage, ownerAccountId: BOB, groupId: GROUP_ID, title: "Group",
    members: [
      { accountId: BOB, role: "member" },
      { accountId: ALICE, role: "admin" },
    ],
    clock: () => 1000,
  });

  const server = makeServer({ ownerAccountId: BOB, storage, sendCapture: null, clock });
  let updated = null;
  server.bus.on("group.updated", (record) => { updated = record; });

  const consumed = await server.bus.services.groups.handleIncomingGroupOp(new GroupOpPayloadV1({
    op: "setAvatar",
    groupId: GROUP_ID,
    avatarFileHash: AVATAR_HASH,
    avatarDataB64: AVATAR_B64,
    actedAtMs: 9999,
    groupOpId: "gop_test_setavatar",
  }), { senderAccountId: ALICE });

  assert.equal(consumed, true);
  assert.ok(updated && updated.group.avatarFileHash === AVATAR_HASH);

  const groupStore = new GroupStore({ storageProvider: storage, clock: () => 1000 });
  const group = await groupStore.getGroup({ ownerAccountId: BOB, groupId: GROUP_ID });
  assert.equal(group.avatarFileHash, AVATAR_HASH);
  const stored = await server.bus.services.fileTransfer.retrieveFileB64(AVATAR_HASH);
  assert.equal(stored, AVATAR_B64);
});

test("incoming setAvatar op older than local update is dropped (LWW)", async () => {
  const storage = new TestStorageProvider();
  let now = 1000;
  const clock = () => (now += 100);

  // Seed the group, then set a photo locally so updatedAtMs is large.
  await seedGroup({
    storage, ownerAccountId: ALICE, groupId: GROUP_ID, title: "Group",
    members: [
      { accountId: ALICE, role: "admin" },
      { accountId: BOB, role: "member" },
    ],
    clock: () => 5000,
  });
  const server = makeServer({ ownerAccountId: ALICE, storage, sendCapture: [], clock: () => 5000 });
  await server.bus.services.groups.setAvatarGroup({ groupId: GROUP_ID, avatarDataB64: AVATAR_B64 });

  // A stale incoming op (older actedAtMs) must not override.
  const staleB64 = bytesToBase64(new TextEncoder().encode("stale-photo"));
  const staleHash = Hash.sha256Hex(base64ToBytes(staleB64));
  await server.bus.services.groups.handleIncomingGroupOp(new GroupOpPayloadV1({
    op: "setAvatar",
    groupId: GROUP_ID,
    avatarFileHash: staleHash,
    avatarDataB64: staleB64,
    actedAtMs: 1, // older than the local set
    groupOpId: "gop_stale",
  }), { senderAccountId: BOB });

  const groupStore = new GroupStore({ storageProvider: storage, clock: () => 5000 });
  const group = await groupStore.getGroup({ ownerAccountId: ALICE, groupId: GROUP_ID });
  assert.equal(group.avatarFileHash, AVATAR_HASH, "local (newer) photo preserved");
});

test("incoming setAvatar with tampered bytes (hash mismatch) is dropped", async () => {
  const storage = new TestStorageProvider();
  let now = 1000;
  const clock = () => (now += 100);

  await seedGroup({
    storage, ownerAccountId: BOB, groupId: GROUP_ID, title: "Group",
    members: [
      { accountId: BOB, role: "member" },
      { accountId: ALICE, role: "admin" },
    ],
    clock: () => 1000,
  });

  const server = makeServer({ ownerAccountId: BOB, storage, sendCapture: null, clock });
  // Advertise AVATAR_HASH but send unrelated bytes — TRUST-2 must reject.
  const wrongB64 = bytesToBase64(new TextEncoder().encode("not-the-real-bytes"));
  const consumed = await server.bus.services.groups.handleIncomingGroupOp(new GroupOpPayloadV1({
    op: "setAvatar",
    groupId: GROUP_ID,
    avatarFileHash: AVATAR_HASH,
    avatarDataB64: wrongB64,
    actedAtMs: 9999,
    groupOpId: "gop_tampered",
  }), { senderAccountId: ALICE });

  assert.equal(consumed, true, "consumed (dropped, not retried)");
  const groupStore = new GroupStore({ storageProvider: storage, clock: () => 1000 });
  const group = await groupStore.getGroup({ ownerAccountId: BOB, groupId: GROUP_ID });
  assert.equal(group.avatarFileHash, "", "tampered avatar not applied");
});

test("group.state catch-up fills the avatar only when local is empty", async () => {
  const storage = new TestStorageProvider();
  let now = 1000;
  const clock = () => (now += 100);

  await seedGroup({
    storage, ownerAccountId: BOB, groupId: GROUP_ID, title: "Group",
    members: [
      { accountId: BOB, role: "member" },
      { accountId: ALICE, role: "admin" },
    ],
    clock: () => 1000,
  });

  const server = makeServer({ ownerAccountId: BOB, storage, sendCapture: null, clock });

  // Late-joiner catch-up: BOB has no photo yet; ALICE advertises one.
  await server.bus.services.groups.handleIncomingGroupOp(new GroupOpPayloadV1({
    op: "group.state",
    groupId: GROUP_ID,
    title: "Group",
    avatarFileHash: AVATAR_HASH,
    avatarDataB64: AVATAR_B64,
    actedAtMs: 1000,
    groupOpId: "gop_state_1",
  }), { senderAccountId: ALICE });

  const groupStore = new GroupStore({ storageProvider: storage, clock: () => 1000 });
  let group = await groupStore.getGroup({ ownerAccountId: BOB, groupId: GROUP_ID });
  assert.equal(group.avatarFileHash, AVATAR_HASH, "empty avatar filled from catch-up");

  // A second catch-up advertising a different photo must NOT overwrite.
  const otherB64 = bytesToBase64(new TextEncoder().encode("a-different-photo"));
  const otherHash = Hash.sha256Hex(base64ToBytes(otherB64));
  await server.bus.services.groups.handleIncomingGroupOp(new GroupOpPayloadV1({
    op: "group.state",
    groupId: GROUP_ID,
    title: "Group",
    avatarFileHash: otherHash,
    avatarDataB64: otherB64,
    actedAtMs: 2000,
    groupOpId: "gop_state_2",
  }), { senderAccountId: ALICE });

  group = await groupStore.getGroup({ ownerAccountId: BOB, groupId: GROUP_ID });
  assert.equal(group.avatarFileHash, AVATAR_HASH, "fill-if-empty never overwrites a live photo");
});
