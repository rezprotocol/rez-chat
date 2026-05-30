import test from "node:test";
import assert from "node:assert/strict";
import { MessageSendParams } from "../src/records/index.js";
import { ChatServerApp } from "../src/server/app/ChatServerApp.js";
import { GroupStore } from "../src/server/storage/ChatGroupStore.js";

// Minimal in-memory key-value store for test isolation
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

// Minimal identity for createRezClient (never actually connects)
const FAKE_IDENTITY = {
  accountId: "rez:acct:test-owner",
  publicKeyB64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  privateKeyB64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
};

const OWNER = "rez:acct:test-owner";
const MEMBER_A = "rez:acct:member-a";
const MEMBER_B = "rez:acct:member-b";
const GROUP_ID = "grp_test1";
const THREAD_ID = "th_group_test1";

function makeNodeRuntime({ sendResult, sendError } = {}) {
  return {
    sendEncryptedDeposit: async (opts) => {
      if (sendError) {
        const err = typeof sendError === "function" ? sendError(opts) : sendError;
        if (err) throw err;
      }
      return sendResult || { ok: true };
    },
    getIdentity: () => ({ localInboxId: "inbox:test-owner" }),
  };
}

async function seedGroupThread(storage, { groupId, threadId, members, createdBy }) {
  // Seed thread — ThreadStoreService uses ownerAccountId as KV store name,
  // key format: app:threads/${ownerAccountId}/${threadId}
  const threadKv = storage.getKeyValueStore(OWNER);
  await threadKv.set("app:threads/" + OWNER + "/" + threadId, {
    threadId,
    threadType: "group",
    groupId,
    title: "Test Group",
    createdAtMs: 1000,
    updatedAtMs: 1000,
  });

  // Use the actual GroupStore to seed group + members (it hashes keys internally).
  // Founder = group.createdBy is the implicit admin (single source of truth);
  // tests that want OWNER as a non-admin must pass an explicit `createdBy`.
  const groupStore = new GroupStore({ storageProvider: storage, clock: () => 1000 });
  await groupStore.ensureGroup({
    ownerAccountId: OWNER,
    groupId,
    createdBy: createdBy || OWNER,
    title: "Test Group",
  });
  for (const m of members) {
    await groupStore.ensureMembership({
      ownerAccountId: OWNER,
      groupId,
      accountId: m.accountId,
      role: m.role || "member",
    });
    // If state is "removed", use removeMember to set it
    if (m.state === "removed") {
      await groupStore.removeMember({
        ownerAccountId: OWNER,
        groupId,
        accountId: m.accountId,
      });
    }
  }
}

function createServer(storage, sdk) {
  return new ChatServerApp({
    identity: FAKE_IDENTITY,
    uplinks: ["ws://localhost:9999"],
    storageProvider: storage,
    ownerAccountId: OWNER,
    clock: () => 1000,
    sdk,
  });
}

function sendThreadMessage(server, payload) {
  const record = new MessageSendParams({
    threadId: payload.mailboxId,
    payload: payload.data,
    messageId: payload.metadata && typeof payload.metadata.messageId === "string" ? payload.metadata.messageId : "",
    targetCapabilityId:
      payload.metadata && typeof payload.metadata.targetCapabilityId === "string"
        ? payload.metadata.targetCapabilityId
        : "",
  });
  return server.bus.call("message", "send", record);
}

test("group fan-out sends to all active members with peer links", async () => {
  const storage = new TestStorageProvider();
  const sent = [];
  const nodeRuntime = {
    sendEncryptedDeposit: async (opts) => { sent.push(opts); return { ok: true }; },
    getIdentity: () => ({ localInboxId: "inbox:test-owner" }),
  };
  await seedGroupThread(storage, {
    groupId: GROUP_ID,
    threadId: THREAD_ID,
    members: [
      { accountId: OWNER, state: "active", role: "admin" },
      { accountId: MEMBER_A, state: "active" },
      { accountId: MEMBER_B, state: "active" },
    ],
  });
  const server = createServer(storage, nodeRuntime);

  await sendThreadMessage(server, {
    mailboxId: THREAD_ID,
    objectId: "obj1",
    data: { kind: "text", text: "hello group" },
    metadata: { messageId: "msg1" },
  });

  assert.equal(sent.length, 2, "should send to 2 members (excluding self)");
  const targets = sent.map((s) => s.peerAccountId).sort();
  assert.deepEqual(targets, [MEMBER_A, MEMBER_B]);
  // deliverInboxId should not be provided (auto-resolved by node)
  for (const s of sent) {
    assert.equal(s.deliverInboxId, undefined);
    const payload = JSON.parse(new TextDecoder().decode(s.plaintextBodyBytes));
    assert.equal(payload.threadId, THREAD_ID);
  }
});

test("members without peer links are skipped (NO_DELIVERY_TARGET)", async () => {
  const storage = new TestStorageProvider();
  const sent = [];
  const nodeRuntime = {
    sendEncryptedDeposit: async (opts) => {
      if (opts.peerAccountId === MEMBER_B) {
        const err = new Error("no peer link");
        err.code = "NO_DELIVERY_TARGET";
        throw err;
      }
      sent.push(opts);
      return { ok: true };
    },
    getIdentity: () => ({ localInboxId: "inbox:test-owner" }),
  };
  await seedGroupThread(storage, {
    groupId: GROUP_ID,
    threadId: THREAD_ID,
    members: [
      { accountId: OWNER, state: "active", role: "admin" },
      { accountId: MEMBER_A, state: "active" },
      { accountId: MEMBER_B, state: "active" },
    ],
  });
  const server = createServer(storage, nodeRuntime);

  // Should not throw — skipped members are tolerated
  await sendThreadMessage(server, {
    mailboxId: THREAD_ID,
    objectId: "obj1",
    data: { kind: "text", text: "hello" },
    metadata: { messageId: "msg2" },
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].peerAccountId, MEMBER_A);
});

test("self is excluded from fan-out targets", async () => {
  const storage = new TestStorageProvider();
  const sent = [];
  const nodeRuntime = {
    sendEncryptedDeposit: async (opts) => { sent.push(opts); return { ok: true }; },
    getIdentity: () => ({ localInboxId: "inbox:test-owner" }),
  };
  await seedGroupThread(storage, {
    groupId: GROUP_ID,
    threadId: THREAD_ID,
    members: [
      { accountId: OWNER, state: "active", role: "admin" },
      { accountId: MEMBER_A, state: "active" },
    ],
  });
  const server = createServer(storage, nodeRuntime);

  await sendThreadMessage(server, {
    mailboxId: THREAD_ID,
    objectId: "obj1",
    data: { kind: "text", text: "hello" },
    metadata: { messageId: "msg3" },
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].peerAccountId, MEMBER_A);
  // Owner should never appear in sent targets
  const selfSends = sent.filter((s) => s.peerAccountId === OWNER);
  assert.equal(selfSends.length, 0);
});

test("empty group (no other active members) returns without sending", async () => {
  const storage = new TestStorageProvider();
  const sent = [];
  const nodeRuntime = {
    sendEncryptedDeposit: async (opts) => { sent.push(opts); return { ok: true }; },
    getIdentity: () => ({ localInboxId: "inbox:test-owner" }),
  };
  await seedGroupThread(storage, {
    groupId: GROUP_ID,
    threadId: THREAD_ID,
    members: [
      { accountId: OWNER, state: "active", role: "admin" },
    ],
  });
  const server = createServer(storage, nodeRuntime);

  await sendThreadMessage(server, {
    mailboxId: THREAD_ID,
    objectId: "obj1",
    data: { kind: "text", text: "hello" },
    metadata: { messageId: "msg4" },
  });

  assert.equal(sent.length, 0, "no messages should be sent for solo group");
});

test("DM path unchanged (regression)", async () => {
  const storage = new TestStorageProvider();
  const sent = [];
  const nodeRuntime = {
    sendEncryptedDeposit: async (opts) => { sent.push(opts); return { ok: true }; },
    getIdentity: () => ({ localInboxId: "inbox:test-owner" }),
  };

  // Seed a DM thread (not a group thread)
  const threadKv = storage.getKeyValueStore(OWNER);
  await threadKv.set("app:threads/" + OWNER + "/th_dm_test", {
    threadId: "th_dm_test",
    threadType: "direct",
    peerAccountId: MEMBER_A,
    peerInboxId: "inbox:member-a",
    createdAtMs: 1000,
    updatedAtMs: 1000,
  });

  const server = createServer(storage, nodeRuntime);

  await sendThreadMessage(server, {
    mailboxId: "th_dm_test",
    objectId: "obj1",
    data: { kind: "text", text: "hello dm" },
    metadata: { messageId: "msg5" },
  });

  // DM sends exactly once to the peer
  assert.equal(sent.length, 1);
  assert.equal(sent[0].peerAccountId, MEMBER_A);
  assert.equal(sent[0].deliverInboxId, "inbox:member-a");
});

test("mixed results: some sent, some skipped, some queued", async () => {
  const storage = new TestStorageProvider();
  const memberC = "rez:acct:member-c";
  const nodeRuntime = {
    sendEncryptedDeposit: async (opts) => {
      if (opts.peerAccountId === MEMBER_A) {
        return { ok: true };
      }
      if (opts.peerAccountId === MEMBER_B) {
        const err = new Error("no peer link");
        err.code = "NO_DELIVERY_TARGET";
        throw err;
      }
      if (opts.peerAccountId === memberC) {
        const err = new Error("queued");
        err.queued = true;
        throw err;
      }
      return { ok: true };
    },
    getIdentity: () => ({ localInboxId: "inbox:test-owner" }),
  };
  await seedGroupThread(storage, {
    groupId: GROUP_ID,
    threadId: THREAD_ID,
    members: [
      { accountId: OWNER, state: "active", role: "admin" },
      { accountId: MEMBER_A, state: "active" },
      { accountId: MEMBER_B, state: "active" },
      { accountId: memberC, state: "active" },
    ],
  });
  const server = createServer(storage, nodeRuntime);

  // Should not throw — mixed results are tolerated as long as sentCount > 0
  await sendThreadMessage(server, {
    mailboxId: THREAD_ID,
    objectId: "obj1",
    data: { kind: "text", text: "hello mixed" },
    metadata: { messageId: "msg6" },
  });
  // If we get here without throwing, the mixed results were handled
  assert.ok(true, "mixed results handled without throwing");
});

test("inactive members are excluded from fan-out", async () => {
  const storage = new TestStorageProvider();
  const sent = [];
  const nodeRuntime = {
    sendEncryptedDeposit: async (opts) => { sent.push(opts); return { ok: true }; },
    getIdentity: () => ({ localInboxId: "inbox:test-owner" }),
  };
  await seedGroupThread(storage, {
    groupId: GROUP_ID,
    threadId: THREAD_ID,
    members: [
      { accountId: OWNER, state: "active", role: "admin" },
      { accountId: MEMBER_A, state: "active" },
      { accountId: MEMBER_B, state: "removed" },
    ],
  });
  const server = createServer(storage, nodeRuntime);

  await sendThreadMessage(server, {
    mailboxId: THREAD_ID,
    objectId: "obj1",
    data: { kind: "text", text: "hello" },
    metadata: { messageId: "msg7" },
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].peerAccountId, MEMBER_A);
});

// ----------------------------------------------------------------------------
// Admin gate on local writes (defense-in-depth)
//
// The inbound peer-op handler already rejects non-admin kick/setRole/rename
// ops, but the LOCAL directives used to skip the check entirely — a non-admin
// could mutate their own view (split-brain) before peers silently dropped
// the broadcast. These tests pin the local-side gate.
// ----------------------------------------------------------------------------

test("group.kick by non-admin throws ADMIN_REQUIRED and does not mutate or fan out", async () => {
  const storage = new TestStorageProvider();
  const sent = [];
  const nodeRuntime = {
    sendEncryptedDeposit: async (opts) => { sent.push(opts); return { ok: true }; },
    getIdentity: () => ({ localInboxId: "inbox:test-owner" }),
  };
  await seedGroupThread(storage, {
    groupId: GROUP_ID,
    threadId: THREAD_ID,
    // MEMBER_A founded the group; OWNER (this server) is a regular member.
    createdBy: MEMBER_A,
    members: [
      { accountId: OWNER, state: "active", role: "member" },
      { accountId: MEMBER_A, state: "active", role: "admin" },
      { accountId: MEMBER_B, state: "active" },
    ],
  });
  const server = createServer(storage, nodeRuntime);
  await assert.rejects(
    () => server.bus.call("group", "kick", { groupId: GROUP_ID, accountId: MEMBER_B }),
    (err) => err && err.code === "ADMIN_REQUIRED",
  );
  assert.equal(sent.length, 0, "no fan-out on rejected kick");
  const groupStore = new GroupStore({ storageProvider: storage, clock: () => 1000 });
  const member = await groupStore.getMembership({ ownerAccountId: OWNER, groupId: GROUP_ID, accountId: MEMBER_B });
  assert.equal(member && member.state, "active", "kick was not applied locally");
});

test("group.setRole by non-admin throws ADMIN_REQUIRED", async () => {
  const storage = new TestStorageProvider();
  const sent = [];
  const nodeRuntime = {
    sendEncryptedDeposit: async (opts) => { sent.push(opts); return { ok: true }; },
    getIdentity: () => ({ localInboxId: "inbox:test-owner" }),
  };
  await seedGroupThread(storage, {
    groupId: GROUP_ID,
    threadId: THREAD_ID,
    // MEMBER_A founded the group; OWNER is a regular member trying to escalate.
    createdBy: MEMBER_A,
    members: [
      { accountId: OWNER, state: "active", role: "member" },
      { accountId: MEMBER_A, state: "active" },
    ],
  });
  const server = createServer(storage, nodeRuntime);
  await assert.rejects(
    () => server.bus.call("group", "setRole", { groupId: GROUP_ID, accountId: MEMBER_A, role: "admin" }),
    (err) => err && err.code === "ADMIN_REQUIRED",
  );
  assert.equal(sent.length, 0, "no fan-out on rejected setRole");
});

test("group.rename by non-admin throws ADMIN_REQUIRED and does not change title", async () => {
  const storage = new TestStorageProvider();
  const sent = [];
  const nodeRuntime = {
    sendEncryptedDeposit: async (opts) => { sent.push(opts); return { ok: true }; },
    getIdentity: () => ({ localInboxId: "inbox:test-owner" }),
  };
  await seedGroupThread(storage, {
    groupId: GROUP_ID,
    threadId: THREAD_ID,
    // MEMBER_A founded the group; OWNER is a regular member trying to rename.
    createdBy: MEMBER_A,
    members: [
      { accountId: OWNER, state: "active", role: "member" },
      { accountId: MEMBER_A, state: "active", role: "admin" },
    ],
  });
  const server = createServer(storage, nodeRuntime);
  await assert.rejects(
    () => server.bus.call("group", "rename", { groupId: GROUP_ID, title: "Hijacked" }),
    (err) => err && err.code === "ADMIN_REQUIRED",
  );
  assert.equal(sent.length, 0, "no fan-out on rejected rename");
  const groupStore = new GroupStore({ storageProvider: storage, clock: () => 1000 });
  const group = await groupStore.getGroup({ ownerAccountId: OWNER, groupId: GROUP_ID });
  assert.equal(group && group.title, "Test Group", "title unchanged");
});
