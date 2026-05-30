import test from "node:test";
import assert from "node:assert/strict";
import { GroupLeaveParams } from "../src/records/index.js";
import { ChatServerApp } from "../src/server/app/ChatServerApp.js";
import { GroupStore } from "../src/server/storage/ChatGroupStore.js";

class TestKVStore {
  constructor() { this._data = new Map(); }
  async get(key) { return this._data.get(key); }
  async set(key, value) { this._data.set(key, value); }
  async delete(key) { this._data.delete(key); }
  async keys(prefix) {
    const out = [];
    for (const k of this._data.keys()) {
      if (k.startsWith(prefix)) out.push(k);
    }
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

const FAKE_IDENTITY = {
  accountId: "rez:acct:test-owner",
  publicKeyB64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  privateKeyB64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
};

const OWNER = "rez:acct:test-owner";
const MEMBER_A = "rez:acct:member-a";
const GROUP_ID = "grp_leave_test";

async function seedGroupThread(storage, { groupId, members }) {
  const groupStore = new GroupStore({ storageProvider: storage, clock: () => 1000 });
  await groupStore.ensureGroup({
    ownerAccountId: OWNER,
    groupId,
    createdBy: OWNER,
    title: "Leave Test Group",
  });
  for (const m of members) {
    await groupStore.ensureMembership({
      ownerAccountId: OWNER,
      groupId,
      accountId: m.accountId,
      role: m.role || "member",
    });
  }
}

function createServer(storage) {
  return new ChatServerApp({
    identity: FAKE_IDENTITY,
    uplinks: ["ws://localhost:9999"],
    storageProvider: storage,
    ownerAccountId: OWNER,
    clock: () => 1000,
    sdk: {
      sendEncryptedDeposit: async () => ({ ok: true }),
      getIdentity: () => ({ localInboxId: "inbox:test-owner" }),
    },
  });
}

test("leaveGroup removes own membership and locks thread", async () => {
  const storage = new TestStorageProvider();
  await seedGroupThread(storage, {
    groupId: GROUP_ID,
    members: [
      { accountId: OWNER, role: "admin" },
      { accountId: MEMBER_A },
    ],
  });
  const server = createServer(storage);

  // Create the thread so setThreadState has something to update
  const threadId = server.bus.services.threads.groupThreadId(GROUP_ID);
  await server.bus.stores.threadStore.ensureThread({
    threadId,
    groupId: GROUP_ID,
    threadType: "group",
    title: "Leave Test Group",
  });

  const params = new GroupLeaveParams({ groupId: GROUP_ID });
  const result = await server.bus.call("group", "leave", params);

  assert.equal(result.groupId, GROUP_ID);
  assert.equal(result.threadId, threadId);
  assert.equal(result.left, true);

  // Verify membership is removed
  const membership = await server.bus.stores.groupStore.getMembership({
    ownerAccountId: OWNER,
    groupId: GROUP_ID,
    accountId: OWNER,
  });
  assert.equal(membership.state, "removed");

  // Verify thread is locked
  const thread = await server.bus.stores.threadStore.getThread(threadId);
  assert.equal(thread.accessState, "locked");
});

test("leaveGroup with invalid groupId throws validation error", async () => {
  assert.throws(
    () => new GroupLeaveParams({ groupId: "" }),
    (err) => {
      assert.ok(err.message.includes("groupId"));
      return true;
    },
  );
});
