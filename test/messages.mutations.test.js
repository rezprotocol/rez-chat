import test from "node:test";
import assert from "node:assert/strict";

import { ThreadStoreService, THREAD_TYPES } from "../src/server/storage/ChatThreadStore.js";
import { PendingMutation, PENDING_MUTATION_KINDS } from "../src/records/domain/PendingMutation.js";

class MemoryKV {
  constructor() {
    this._data = new Map();
  }
  async get(key) { return this._data.get(key) || null; }
  async set(key, value) { this._data.set(key, value); }
  async delete(key) { this._data.delete(key); }
  async keys(prefix) {
    const out = [];
    for (const key of this._data.keys()) {
      if (String(key).startsWith(prefix)) out.push(key);
    }
    return out.sort((a, b) => a.localeCompare(b));
  }
}

class MemoryStorageProvider {
  constructor(kv) { this._kv = kv || new MemoryKV(); }
  getKeyValueStore() { return this._kv; }
}

function newClock(start = 10_000) {
  let now = start;
  return {
    tick: () => { now += 1; return now; },
    fn: () => now,
    setNow: (next) => { now = next; },
  };
}

async function makeReadyStore({ kv = new MemoryKV(), clock } = {}) {
  const ck = clock || newClock();
  const storageProvider = new MemoryStorageProvider(kv);
  const store = new ThreadStoreService({
    storageProvider,
    ownerAccountId: "rez:acct:owner",
    clock: ck.fn,
  });
  const threadId = "th_TESTAAAAAAAAAAAAAAAAAAA";
  await store.ensureThread({
    threadId,
    threadType: THREAD_TYPES.DIRECT,
    peerAccountId: "rez:acct:peer",
    peerInboxId: "inbox:peer",
  });
  return { store, threadId, kv, clock: ck, storageProvider };
}

async function depositMessage(store, threadId, {
  messageId,
  senderAccountId = "rez:acct:peer",
  text = "hello",
  payload = null,
  acceptedAtMs = 10_100,
} = {}) {
  // Mirror the production receive path: lift inReplyToMessageId out of
  // the wire payload onto the row before persisting.
  const inReplyToMessageId = payload && typeof payload.inReplyToMessageId === "string"
    ? payload.inReplyToMessageId : "";
  return store.upsertDepositedMessage({
    threadId,
    messageId,
    senderKey: senderAccountId,
    senderAccountId,
    packetB64: "AQID",
    acceptedAtMs,
    text,
    payload,
    inReplyToMessageId,
  });
}

test("applyReaction adds and removes a single emoji idempotently", async () => {
  const { store, threadId } = await makeReadyStore();
  await depositMessage(store, threadId, { messageId: "m1" });

  const add = await store.applyReaction({
    threadId,
    targetMessageId: "m1",
    senderAccountId: "rez:acct:peer",
    emoji: "👍",
    op: "add",
  });
  assert.equal(add.applied, true);
  assert.deepEqual(add.message.reactions, { "👍": ["rez:acct:peer"] });

  const dup = await store.applyReaction({
    threadId,
    targetMessageId: "m1",
    senderAccountId: "rez:acct:peer",
    emoji: "👍",
    op: "add",
  });
  assert.equal(dup.applied, false);
  assert.equal(dup.reason, "no_change");

  const remove = await store.applyReaction({
    threadId,
    targetMessageId: "m1",
    senderAccountId: "rez:acct:peer",
    emoji: "👍",
    op: "remove",
  });
  assert.equal(remove.applied, true);
  assert.deepEqual(remove.message.reactions, {});

  const removeAgain = await store.applyReaction({
    threadId,
    targetMessageId: "m1",
    senderAccountId: "rez:acct:peer",
    emoji: "👍",
    op: "remove",
  });
  assert.equal(removeAgain.applied, false);
  assert.equal(removeAgain.reason, "no_change");
});

test("applyReaction supports multiple emojis per user on the same message", async () => {
  const { store, threadId } = await makeReadyStore();
  await depositMessage(store, threadId, { messageId: "m1" });

  await store.applyReaction({
    threadId,
    targetMessageId: "m1",
    senderAccountId: "rez:acct:peer",
    emoji: "👍",
    op: "add",
  });
  const r = await store.applyReaction({
    threadId,
    targetMessageId: "m1",
    senderAccountId: "rez:acct:peer",
    emoji: "❤️",
    op: "add",
  });
  assert.deepEqual(r.message.reactions, {
    "👍": ["rez:acct:peer"],
    "❤️": ["rez:acct:peer"],
  });
});

test("applyEdit enforces sender authorization and last-write-wins", async () => {
  const { store, threadId, clock } = await makeReadyStore();
  await depositMessage(store, threadId, {
    messageId: "m1",
    senderAccountId: "rez:acct:peer",
    text: "hi",
  });

  const unauthorized = await store.applyEdit({
    threadId,
    targetMessageId: "m1",
    senderAccountId: "rez:acct:attacker",
    newText: "rewritten",
    editedAtMs: clock.tick(),
  });
  assert.equal(unauthorized.applied, false);
  assert.equal(unauthorized.rejected, true);
  assert.equal(unauthorized.reason, "unauthorized");

  const firstEditAt = 12_000;
  const ok = await store.applyEdit({
    threadId,
    targetMessageId: "m1",
    senderAccountId: "rez:acct:peer",
    newText: "edited once",
    editedAtMs: firstEditAt,
  });
  assert.equal(ok.applied, true);
  assert.equal(ok.message.text, "edited once");
  assert.equal(ok.message.editedAtMs, firstEditAt);

  const stale = await store.applyEdit({
    threadId,
    targetMessageId: "m1",
    senderAccountId: "rez:acct:peer",
    newText: "stale ghost",
    editedAtMs: firstEditAt - 100,
  });
  assert.equal(stale.applied, false);
  assert.equal(stale.reason, "stale");
  assert.equal(stale.message.text, "edited once");

  const newer = await store.applyEdit({
    threadId,
    targetMessageId: "m1",
    senderAccountId: "rez:acct:peer",
    newText: "edited twice",
    editedAtMs: firstEditAt + 100,
  });
  assert.equal(newer.applied, true);
  assert.equal(newer.message.text, "edited twice");
});

test("applyTombstone clears text, blocks edits, and is idempotent", async () => {
  const { store, threadId } = await makeReadyStore();
  await depositMessage(store, threadId, {
    messageId: "m1",
    senderAccountId: "rez:acct:peer",
    text: "to delete",
  });

  const tombstone = await store.applyTombstone({
    threadId,
    targetMessageId: "m1",
    senderAccountId: "rez:acct:peer",
    tombstonedAtMs: 13_000,
  });
  assert.equal(tombstone.applied, true);
  assert.equal(tombstone.message.text, "");
  assert.equal(tombstone.message.tombstonedAtMs, 13_000);

  const editAfter = await store.applyEdit({
    threadId,
    targetMessageId: "m1",
    senderAccountId: "rez:acct:peer",
    newText: "ressurected",
    editedAtMs: 14_000,
  });
  assert.equal(editAfter.applied, false);
  assert.equal(editAfter.reason, "tombstoned");

  const tombstoneAgain = await store.applyTombstone({
    threadId,
    targetMessageId: "m1",
    senderAccountId: "rez:acct:peer",
    tombstonedAtMs: 15_000,
  });
  assert.equal(tombstoneAgain.applied, false);
  assert.equal(tombstoneAgain.reason, "already_tombstoned");
});

test("applyTombstone rejects when sender does not match original author", async () => {
  const { store, threadId } = await makeReadyStore();
  await depositMessage(store, threadId, {
    messageId: "m1",
    senderAccountId: "rez:acct:peer",
    text: "victim",
  });
  const result = await store.applyTombstone({
    threadId,
    targetMessageId: "m1",
    senderAccountId: "rez:acct:attacker",
    tombstonedAtMs: 13_000,
  });
  assert.equal(result.applied, false);
  assert.equal(result.rejected, true);
  assert.equal(result.reason, "unauthorized");
});

test("inReplyToMessageId persists from payload onto stored row", async () => {
  const { store, threadId } = await makeReadyStore();
  await depositMessage(store, threadId, { messageId: "m1", text: "first" });
  await depositMessage(store, threadId, {
    messageId: "m2",
    text: "reply",
    payload: { kind: "rez.chat.message.v1", text: "reply", inReplyToMessageId: "m1" },
    acceptedAtMs: 10_200,
  });
  const result = await store.listMessages({ threadId, limit: 10 });
  const reply = result.items.find((m) => m.messageId === "m2");
  assert.ok(reply, "reply row must exist");
  assert.equal(reply.inReplyToMessageId, "m1");
});

test("applyLocalDelete removes the row entirely", async () => {
  const { store, threadId } = await makeReadyStore();
  await depositMessage(store, threadId, { messageId: "m1" });
  const before = await store.listMessages({ threadId, limit: 10 });
  assert.equal(before.items.length, 1);

  const result = await store.applyLocalDelete({ threadId, targetMessageId: "m1" });
  assert.equal(result.removed, true);

  const after = await store.listMessages({ threadId, limit: 10 });
  assert.equal(after.items.length, 0);

  const noop = await store.applyLocalDelete({ threadId, targetMessageId: "m1" });
  assert.equal(noop.removed, false);
});

test("out-of-order: edit arriving before target is buffered and drained on insert", async () => {
  const { store, threadId } = await makeReadyStore();

  const buffered = await store.applyEdit({
    threadId,
    targetMessageId: "m1",
    senderAccountId: "rez:acct:peer",
    newText: "edited body",
    editedAtMs: 12_500,
    receivedAtMs: 12_500,
  });
  assert.equal(buffered.applied, false);
  assert.equal(buffered.reason, "target_not_found");
  assert.equal(buffered.buffered, true);

  const persist = await depositMessage(store, threadId, {
    messageId: "m1",
    senderAccountId: "rez:acct:peer",
    text: "original body",
    acceptedAtMs: 13_000,
  });
  // The deposit must report that buffered mutations folded in, so the event
  // layer knows to emit message.updated on top of message.deposited.
  assert.equal(persist.mutated, true, "deposit reports the drained mutation");
  assert.ok(persist.message, "deposit returns the mutated message");
  assert.equal(persist.message.text, "edited body");

  const result = await store.listMessages({ threadId, limit: 10 });
  const drained = result.items.find((m) => m.messageId === "m1");
  assert.ok(drained, "target should exist after insert");
  assert.equal(drained.text, "edited body");
  assert.equal(drained.editedAtMs, 12_500);
});

test("plain deposit (no buffered mutations) reports mutated:false", async () => {
  const { store, threadId } = await makeReadyStore();
  const persist = await depositMessage(store, threadId, { messageId: "m1", text: "hi" });
  assert.equal(persist.inserted, true);
  assert.equal(persist.mutated, false, "no drain → no follow-up message.updated");
});

test("out-of-order: multiple mutations apply in receivedAtMs order on drain", async () => {
  const { store, threadId } = await makeReadyStore();

  await store.applyReaction({
    threadId,
    targetMessageId: "m1",
    senderAccountId: "rez:acct:peer",
    emoji: "👍",
    op: "add",
    receivedAtMs: 11_500,
  });
  await store.applyEdit({
    threadId,
    targetMessageId: "m1",
    senderAccountId: "rez:acct:peer",
    newText: "v1",
    editedAtMs: 12_000,
    receivedAtMs: 12_000,
  });
  await store.applyEdit({
    threadId,
    targetMessageId: "m1",
    senderAccountId: "rez:acct:peer",
    newText: "v2",
    editedAtMs: 12_500,
    receivedAtMs: 12_500,
  });

  await depositMessage(store, threadId, {
    messageId: "m1",
    senderAccountId: "rez:acct:peer",
    text: "original",
    acceptedAtMs: 13_000,
  });

  const result = await store.listMessages({ threadId, limit: 10 });
  const drained = result.items.find((m) => m.messageId === "m1");
  assert.equal(drained.text, "v2");
  assert.deepEqual(drained.reactions, { "👍": ["rez:acct:peer"] });
});

test("out-of-order: buffered mutation survives store restart", async () => {
  const kv = new MemoryKV();
  const first = await makeReadyStore({ kv });
  await first.store.applyEdit({
    threadId: first.threadId,
    targetMessageId: "m1",
    senderAccountId: "rez:acct:peer",
    newText: "edit before restart",
    editedAtMs: 12_500,
    receivedAtMs: 12_500,
  });

  // Restart: same KV, fresh store instance.
  const reborn = new ThreadStoreService({
    storageProvider: new MemoryStorageProvider(kv),
    ownerAccountId: "rez:acct:owner",
    clock: () => 13_500,
  });

  await reborn.upsertDepositedMessage({
    threadId: first.threadId,
    messageId: "m1",
    senderKey: "rez:acct:peer",
    senderAccountId: "rez:acct:peer",
    packetB64: "AQID",
    acceptedAtMs: 13_000,
    text: "original",
  });
  const result = await reborn.listMessages({ threadId: first.threadId, limit: 10 });
  const drained = result.items.find((m) => m.messageId === "m1");
  assert.equal(drained.text, "edit before restart");
  assert.equal(drained.editedAtMs, 12_500);
});

test("cleanupStalePendingMutations drops entries older than the TTL", async () => {
  const { store } = await makeReadyStore({ clock: { fn: () => 100_000_000_000, tick: () => {}, setNow: () => {} } });
  await store._writePendingMutations("m-old", [new PendingMutation({
    kind: PENDING_MUTATION_KINDS.EDIT,
    threadId: "th_X",
    targetMessageId: "m-old",
    senderAccountId: "rez:acct:peer",
    newText: "x",
    editedAtMs: 1,
    receivedAtMs: 1,
  })]);
  await store._writePendingMutations("m-fresh", [new PendingMutation({
    kind: PENDING_MUTATION_KINDS.EDIT,
    threadId: "th_X",
    targetMessageId: "m-fresh",
    senderAccountId: "rez:acct:peer",
    newText: "x",
    editedAtMs: 99_999_000_000,
    receivedAtMs: 99_999_000_000,
  })]);
  await store.cleanupStalePendingMutations();
  const stale = await store._loadPendingMutations("m-old");
  assert.equal(stale.length, 0);
  const fresh = await store._loadPendingMutations("m-fresh");
  assert.equal(fresh.length, 1);
});
