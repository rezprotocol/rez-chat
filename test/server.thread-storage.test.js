import test from "node:test";
import assert from "node:assert/strict";

import { ThreadStoreService, THREAD_TYPES } from "../src/server/storage/ChatThreadStore.js";
import { ThreadIndexService } from "../src/server/storage/ChatThreadIndex.js";
import { ContactStore } from "../src/server/storage/ChatContactStore.js";
import { BackupStoreService } from "../src/server/storage/ChatBackupStore.js";

class MemoryKV {
  constructor() {
    this._data = new Map();
  }

  async get(key) {
    return this._data.get(key) || null;
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
      if (String(key).startsWith(prefix)) out.push(key);
    }
    return out.sort((a, b) => a.localeCompare(b));
  }
}

class MemoryStorageProvider {
  constructor() {
    this._kv = new MemoryKV();
  }

  getKeyValueStore() {
    return this._kv;
  }
}

function createThreadStore(storageProvider, ownerAccountId, clock) {
  return new ThreadStoreService({
    storageProvider,
    ownerAccountId,
    clock,
  });
}

function createThreadIndex(storageProvider, ownerAccountId, threadStore, clock) {
  return new ThreadIndexService({
    storageProvider,
    ownerAccountId,
    threadStore,
    clock,
  });
}

async function ensureReadyDirectThread(store, threadId) {
  return store.ensureThread({
    threadId,
    threadType: THREAD_TYPES.DIRECT,
    peerAccountId: "rez:acct:peer",
    peerInboxId: "inbox:peer",
  });
}

test("chat thread store owns app-scoped thread, message, and idempotency keys", async () => {
  const storageProvider = new MemoryStorageProvider();
  const storeA = createThreadStore(storageProvider, "rez:acct:A", () => 1234);
  const storeB = createThreadStore(storageProvider, "rez:acct:B", () => 1234);
  const threadId = "th_AAAAAAAAAAAAAAAAAAAAAA";

  await ensureReadyDirectThread(storeA, threadId);
  await storeA.recordOutboundDeposit({
    threadId,
    senderKey: "dev:A",
    messageId: "pkt-1",
    packetB64: "AQID",
    acceptedAtMs: 1300,
  });

  const aMessages = await storeA.listMessages({ threadId, limit: 10 });
  assert.equal(aMessages.items.length, 1);
  assert.equal(aMessages.items[0].status, "pending");
  assert.equal(await storeB.getThread(threadId), null);

  const keys = await storageProvider.getKeyValueStore().keys("app:");
  assert.ok(keys.some((key) => key.startsWith("app:threads/rez:acct:A/")));
  assert.ok(keys.some((key) => key.startsWith("app:messages/rez:acct:A/")));
  assert.ok(keys.some((key) => key.startsWith("app:idempotency/rez:acct:A/")));
  assert.equal(keys.some((key) => key.startsWith("app:threads/rez:acct:B/")), false);
});

test("chat thread store supports queued outbound lifecycle without moving ownership to node", async () => {
  const store = createThreadStore(new MemoryStorageProvider(), "rez:acct:owner", () => 2000);
  const threadId = "th_QUEUEDAAAAAAAAAAAAAAAAA";
  await ensureReadyDirectThread(store, threadId);

  const created = await store.recordOutboundDeposit({
    threadId,
    senderKey: "rez:acct:owner",
    messageId: "pkt-1",
    packetB64: "data",
  });
  assert.equal(created.status, "pending");

  const queued = await store.setMessageStatus({ threadId, messageId: "pkt-1", status: "queued" });
  assert.equal(queued.status, "queued");
  const sent = await store.setMessageStatus({ threadId, messageId: "pkt-1", status: "sent" });
  assert.equal(sent.status, "sent");
  const delivered = await store.setMessageStatus({ threadId, messageId: "pkt-1", status: "delivered" });
  assert.equal(delivered.status, "delivered");
});

test("chat thread index owns unread and preview derivation", async () => {
  const storageProvider = new MemoryStorageProvider();
  const threadStore = createThreadStore(storageProvider, "rez:acct:A", () => 3000);
  const threadIndex = createThreadIndex(storageProvider, "rez:acct:A", threadStore, () => 3000);
  const threadId = "th_INDEXAAAAAAAAAAAAAAAAAA";
  await ensureReadyDirectThread(threadStore, threadId);
  await threadIndex.markThreadRead({ threadId });

  await threadStore.upsertDepositedMessage({
    threadId,
    messageId: "m1",
    senderKey: "dev:B",
    senderAccountId: "rez:acct:B",
    packetB64: "AQID",
    acceptedAtMs: 3100,
  });
  await threadIndex.upsertOnMessageAccepted({
    threadId,
    messageId: "m1",
    createdAtMs: 3100,
    senderAccountId: "rez:acct:B",
    preview: "hello",
  });

  const record = await threadIndex.getIndexRecord({ threadId });
  assert.equal(record.unreadCount, 1);
  assert.equal(record.lastMessagePreview, "hello");

  await threadIndex.upsertOnMessageAccepted({
    threadId,
    messageId: "m1",
    createdAtMs: 3100,
    senderAccountId: "rez:acct:B",
    preview: "duplicate",
  });
  const duplicate = await threadIndex.getIndexRecord({ threadId });
  assert.equal(duplicate.unreadCount, 1);
  assert.equal(duplicate.lastMessagePreview, "hello");
});

test("markChannelRead survives a follow-up message in another channel without resurfacing reads", async () => {
  // Regression: upsertOnMessageAccepted used to recompute unread from the
  // thread-level marker only, ignoring per-channel cursors. A new message
  // in any channel would then re-mark previously-read channels as unread.
  const storageProvider = new MemoryStorageProvider();
  let now = 5000;
  const clock = () => now;
  const threadStore = createThreadStore(storageProvider, "rez:acct:A", clock);
  const threadIndex = createThreadIndex(storageProvider, "rez:acct:A", threadStore, clock);
  const threadId = "th_CHANNELRESURFACEAAAAA";
  await threadStore.ensureThread({
    threadId,
    threadType: THREAD_TYPES.GROUP,
    groupId: "grp_X",
  });

  // Two #dev messages from a peer.
  now = 5100;
  await threadStore.upsertDepositedMessage({
    threadId,
    messageId: "dev-1",
    senderKey: "rez:acct:B",
    senderAccountId: "rez:acct:B",
    packetB64: "AQ==",
    acceptedAtMs: now,
    payload: { kind: "rez.chat.message.v1", channelId: "dev" },
  });
  await threadIndex.upsertOnMessageAccepted({
    threadId, messageId: "dev-1", createdAtMs: now,
    senderAccountId: "rez:acct:B", preview: "hi dev 1",
  });
  now = 5200;
  await threadStore.upsertDepositedMessage({
    threadId,
    messageId: "dev-2",
    senderKey: "rez:acct:B",
    senderAccountId: "rez:acct:B",
    packetB64: "AQ==",
    acceptedAtMs: now,
    payload: { kind: "rez.chat.message.v1", channelId: "dev" },
  });
  await threadIndex.upsertOnMessageAccepted({
    threadId, messageId: "dev-2", createdAtMs: now,
    senderAccountId: "rez:acct:B", preview: "hi dev 2",
  });

  let rec = await threadIndex.getIndexRecord({ threadId });
  assert.equal(rec.unreadCount, 2);
  assert.deepEqual(rec.unreadByChannelId, { dev: 2 });

  // User opens #dev — should clear the dev bucket.
  now = 5300;
  await threadIndex.markChannelRead({ threadId, channelId: "dev" });
  rec = await threadIndex.getIndexRecord({ threadId });
  assert.equal(rec.unreadCount, 0);
  assert.deepEqual(rec.unreadByChannelId, {});

  // New message arrives in #general — only that one should count as unread.
  now = 5400;
  await threadStore.upsertDepositedMessage({
    threadId,
    messageId: "gen-1",
    senderKey: "rez:acct:B",
    senderAccountId: "rez:acct:B",
    packetB64: "AQ==",
    acceptedAtMs: now,
    payload: { kind: "rez.chat.message.v1" },
  });
  await threadIndex.upsertOnMessageAccepted({
    threadId, messageId: "gen-1", createdAtMs: now,
    senderAccountId: "rez:acct:B", preview: "hi general",
  });
  rec = await threadIndex.getIndexRecord({ threadId });
  assert.equal(rec.unreadCount, 1, "only the new #general message should be unread");
  assert.deepEqual(rec.unreadByChannelId, { "": 1 });
});

test("chat contact store owns contact relationship semantics", async () => {
  const contactStore = new ContactStore({
    storageProvider: new MemoryStorageProvider(),
    clock: () => 4000,
  });

  const result = await contactStore.upsert({
    ownerAccountId: "rez:acct:A",
    accountId: "rez:acct:B",
    patch: {
      displayName: "Bee",
      relationshipState: "active",
    },
  });
  assert.equal(result.created, true);
  assert.equal(result.contact.displayName, "Bee");

  const renamed = await contactStore.rename({
    ownerAccountId: "rez:acct:A",
    accountId: "rez:acct:B",
    displayName: "B",
  });
  assert.equal(renamed.contact.displayName, "B");
});

test("chat backup store owns chat.backup.v1 artifact semantics over opaque storage", async () => {
  const backupStore = new BackupStoreService({
    storageProvider: new MemoryStorageProvider(),
    ownerAccountId: "rez:acct:A",
    clock: () => 5000,
    retentionDays: 7,
  });

  const put = await backupStore.putDelta({
    seq: 1,
    encryptedDelta: "AQID",
    createdAtMs: 5000,
  });
  assert.equal(put.ok, true);
  assert.equal(put.seq, 1);

  const listed = await backupStore.list({ limit: 10 });
  assert.equal(listed.items.length, 1);
  assert.equal(listed.items[0].type, "delta");

  const blob = await backupStore.getBlob({ type: "delta", seq: 1 });
  assert.equal(blob.ciphertextB64, "AQID");
});
