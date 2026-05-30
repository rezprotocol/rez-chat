import test from "node:test";
import assert from "node:assert/strict";

import { MessageSendParams } from "../src/records/index.js";
import { ChatServerApp } from "../src/server/app/ChatServerApp.js";

class TestKVStore {
  constructor() {
    this._data = new Map();
  }

  async get(key) {
    return this._data.get(key);
  }

  async set(key, value) {
    this._data.set(key, value);
  }

  async delete(key) {
    this._data.delete(key);
  }

  async keys(prefix) {
    const out = [];
    for (const key of this._data.keys()) {
      if (key.startsWith(prefix)) out.push(key);
    }
    return out;
  }
}

class TestStorageProvider {
  constructor() {
    this._stores = new Map();
  }

  getKeyValueStore(name) {
    const key = String(name || "");
    if (!this._stores.has(key)) {
      this._stores.set(key, new TestKVStore());
    }
    return this._stores.get(key);
  }

  getObjectStore() {
    return {
      deposit: async () => ({}),
      list: async () => [],
    };
  }

  getMailboxStore() {
    return {
      deposit: async () => ({ eventId: "mailbox_event_1" }),
      poll: async () => [],
    };
  }
}

const FAKE_IDENTITY = {
  accountId: "rez:acct:test-owner",
  publicKeyB64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  privateKeyB64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
};

function createServer({ storage, sdk, clock } = {}) {
  return new ChatServerApp({
    identity: FAKE_IDENTITY,
    uplinks: ["ws://localhost:9999"],
    storageProvider: storage,
    ownerAccountId: "rez:acct:test-owner",
    sdk,
    clock,
  });
}

test("thread.get returns canonical summary fields rebuilt from persisted message history", async () => {
  const storage = new TestStorageProvider();
  const server = createServer({
    storage,
    sdk: {
      sendEncryptedDeposit: async () => ({ ok: true }),
      getIdentity: () => ({ localInboxId: "inbox:test-owner" }),
    },
    clock: () => 5000,
  });
  const threadId = "th_summary_contract";

  await server.threadStore.ensureThread({
    threadId,
    threadType: "direct",
    peerAccountId: "rez:acct:peer",
    peerInboxId: "inbox:peer",
    createdAtMs: 1000,
  });
  await server.threadStore.upsertDepositedMessage({
    messageId: "msg_summary_1",
    threadId,
    senderKey: "rez:acct:peer",
    packetB64: "",
    acceptedAtMs: 2000,
    senderAccountId: "rez:acct:peer",
    status: "delivered",
    text: "hello from history",
  });

  const result = await server.bus.call("thread", "get", { threadId, limit: 50 });
  assert.equal(result.thread.threadId, threadId);
  assert.equal(result.thread.lastMessagePreview, "hello from history");
  assert.equal(result.thread.lastActivityMsgId, "msg_summary_1");
  assert.equal(result.thread.lastActivityAtMs, 2000);
  assert.equal(Array.isArray(result.messages.items), true);
  assert.equal(result.messages.items.length, 1);

  const indexRecord = await server.threadIndex.getIndexRecord({ threadId });
  assert.equal(indexRecord.lastMessagePreview, "hello from history");
  assert.equal(indexRecord.lastActivityMsgId, "msg_summary_1");

  const threads = await server.bus.call("threads", "list", { limit: 50 });
  assert.equal(Array.isArray(threads.threads), true);
  assert.equal(threads.threads.length, 1);
  assert.equal(threads.threads[0].lastMessagePreview, "hello from history");
});

test("message.send normalizes messageId into result, events, and persisted message rows", async () => {
  const storage = new TestStorageProvider();
  const statusEvents = [];
  const threadIndexEvents = [];
  const server = createServer({
    storage,
    sdk: {
      sendEncryptedDeposit: async () => ({ ok: true }),
      getIdentity: () => ({ localInboxId: "inbox:test-owner" }),
    },
    clock: () => 7000,
  });
  const threadId = "th_send_contract";

  server.bus.on("message.status", (record) => {
    statusEvents.push(record);
  });
  server.bus.on("thread.index.updated", (record) => {
    threadIndexEvents.push(record);
  });

  await server.threadStore.ensureThread({
    threadId,
    threadType: "direct",
    peerAccountId: "rez:acct:peer",
    peerInboxId: "inbox:peer",
    createdAtMs: 1000,
  });

  const result = await server.bus.call("message", "send", new MessageSendParams({
    threadId,
    payload: { kind: "text", text: "hello send" },
  }));

  assert.equal(result.threadId, threadId);
  assert.equal(typeof result.messageId, "string");
  assert.equal(result.messageId.length > 0, true);
  assert.equal(result.acceptedAtMs, 7000);

  const messages = await server.threadStore.listMessages({ threadId, limit: 50 });
  assert.equal(Array.isArray(messages.items), true);
  assert.equal(messages.items.length, 1);
  assert.equal(messages.items[0].messageId, result.messageId);

  assert.equal(statusEvents.length > 0, true);
  assert.equal(statusEvents[0].messageId, result.messageId);
  assert.equal(threadIndexEvents.length > 0, true);
  assert.equal(threadIndexEvents[0].threadId, threadId);
  assert.equal(threadIndexEvents[0].preview, "hello send");
});

test("message.send marks direct messages queued when remote send is persisted for later delivery", async () => {
  const storage = new TestStorageProvider();
  const statusEvents = [];
  const server = createServer({
    storage,
    sdk: {
      sendEncryptedDeposit: async () => {
        const err = new Error("queued");
        err.queued = true;
        throw err;
      },
      getIdentity: () => ({ localInboxId: "inbox:test-owner" }),
    },
    clock: () => 9000,
  });
  const threadId = "th_send_queued_contract";

  server.bus.on("message.status", (record) => {
    statusEvents.push(record);
  });

  await server.threadStore.ensureThread({
    threadId,
    threadType: "direct",
    peerAccountId: "rez:acct:peer",
    peerInboxId: "inbox:peer",
    createdAtMs: 1000,
  });

  const result = await server.bus.call("message", "send", new MessageSendParams({
    threadId,
    payload: { kind: "text", text: "hello queued" },
  }));

  assert.equal(result.threadId, threadId);
  assert.equal(typeof result.messageId, "string");
  assert.equal(result.messageId.length > 0, true);

  const messages = await server.threadStore.listMessages({ threadId, limit: 50 });
  assert.equal(Array.isArray(messages.items), true);
  assert.equal(messages.items.length, 1);
  assert.equal(messages.items[0].status, "queued");
  assert.equal(messages.items[0].messageId, result.messageId);

  const queuedStatus = statusEvents.find((record) => String(record && record.status || "") === "queued") || null;
  assert.equal(queuedStatus !== null, true);
  assert.equal(queuedStatus.messageId, result.messageId);
});

test("thread.read emits thread.index.updated with unread cleared", async () => {
  const storage = new TestStorageProvider();
  const threadIndexEvents = [];
  const server = createServer({
    storage,
    sdk: {
      sendEncryptedDeposit: async () => ({ ok: true }),
      getIdentity: () => ({ localInboxId: "inbox:test-owner" }),
    },
    clock: () => 12000,
  });
  const threadId = "th_read_contract";

  server.bus.on("thread.index.updated", (record) => {
    threadIndexEvents.push(record);
  });

  await server.threadStore.ensureThread({
    threadId,
    threadType: "direct",
    peerAccountId: "rez:acct:peer",
    peerInboxId: "inbox:peer",
    createdAtMs: 1000,
  });
  await server.threadStore.upsertDepositedMessage({
    messageId: "msg_read_1",
    threadId,
    senderKey: "rez:acct:peer",
    packetB64: "",
    acceptedAtMs: 2000,
    senderAccountId: "rez:acct:peer",
    status: "delivered",
    text: "hello unread",
  });
  await server.threadIndex.upsertFromMessage({
    threadId,
    messageId: "msg_read_1",
    ts: 2000,
    preview: "hello unread",
    senderAccountId: "rez:acct:peer",
  });

  const result = await server.bus.call("thread", "read", { threadId });
  assert.equal(result.threadId, threadId);
  assert.equal(threadIndexEvents.length, 1);
  assert.equal(threadIndexEvents[0].threadId, threadId);
  assert.equal(threadIndexEvents[0].unreadCount, 0);
  assert.equal(threadIndexEvents[0].preview, "hello unread");
});
