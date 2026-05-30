import test from "node:test";
import assert from "node:assert/strict";
import { InboxCatchupCursor } from "../src/server/inbox/InboxCatchupCursor.js";
import { InboxCatchupService } from "../src/server/services/InboxCatchupService.js";
import { ChatServerBus } from "../src/server/app/ChatServerBus.js";

class MemKv {
  constructor() { this.data = new Map(); }
  async get(key) { return this.data.has(key) ? this.data.get(key) : null; }
  async set(key, value) { this.data.set(key, value); }
  async delete(key) { this.data.delete(key); }
}

class MemStorage {
  constructor() { this.kv = new MemKv(); }
  getKeyValueStore() { return this.kv; }
}

function makeSdkWithMailbox({ items, fetchByEventId, listSpy, fetchSpy }) {
  return {
    connectivity: {
      onReconnected(handler) {
        return () => {};
      },
    },
    mailbox: {
      async list({ mailboxId, cursor, limit }) {
        if (listSpy) listSpy.push({ mailboxId, cursor, limit });
        const all = items[mailboxId] || [];
        const start = cursor ? all.findIndex((i) => i.eventId === cursor) + 1 : 0;
        const sliced = all.slice(start, start + (limit || 50));
        const nextCursor = start + sliced.length < all.length ? sliced[sliced.length - 1].eventId : null;
        return { items: sliced, nextCursor };
      },
      async fetch({ mailboxId, eventId }) {
        if (fetchSpy) fetchSpy.push({ mailboxId, eventId });
        return fetchByEventId[mailboxId + "|" + eventId] || null;
      },
    },
  };
}

test("InboxCatchupCursor.read/write round-trips through KV", async () => {
  const kv = new MemKv();
  const cursor = new InboxCatchupCursor({ kvStore: kv });

  assert.equal(await cursor.read("inbox:a"), null, "initially null");

  await cursor.write("inbox:a", "evt_007", { nowMs: 1000 });
  assert.equal(await cursor.read("inbox:a"), "evt_007");

  await cursor.write("inbox:a", "evt_015", { nowMs: 2000 });
  assert.equal(await cursor.read("inbox:a"), "evt_015", "subsequent write overwrites");

  // Independent per inbox.
  await cursor.write("inbox:b", "other", { nowMs: 3000 });
  assert.equal(await cursor.read("inbox:a"), "evt_015");
  assert.equal(await cursor.read("inbox:b"), "other");
});

test("InboxCatchupCursor.read tolerates legacy string values", async () => {
  const kv = new MemKv();
  await kv.set("chat-server:inbox:catchup-cursor:v1:inbox:legacy", "evt_legacy");
  const cursor = new InboxCatchupCursor({ kvStore: kv });
  assert.equal(await cursor.read("inbox:legacy"), "evt_legacy");
});

test("InboxCatchupService drains all pending items on first start", async () => {
  const INBOX = "inbox:owner";
  const listSpy = [];
  const fetchSpy = [];
  const sdk = makeSdkWithMailbox({
    items: {
      [INBOX]: [
        { eventId: "evt_a", objectId: "o1", createdAt: 100 },
        { eventId: "evt_b", objectId: "o2", createdAt: 200 },
        { eventId: "evt_c", objectId: "o3", createdAt: 300 },
      ],
    },
    fetchByEventId: {
      [INBOX + "|evt_a"]: { ciphertextB64: "AA==", objectId: "o1" },
      [INBOX + "|evt_b"]: { ciphertextB64: "BB==", objectId: "o2" },
      [INBOX + "|evt_c"]: { ciphertextB64: "CC==", objectId: "o3" },
    },
    listSpy,
    fetchSpy,
  });

  const bus = new ChatServerBus();
  bus.runtime.sdk = sdk;
  const storage = new MemStorage();
  const inboxClaimant = { inboxId: INBOX };

  const emitted = [];
  bus.on("runtime.event.mailbox.deposited", (frame) => emitted.push(frame));

  const service = new InboxCatchupService({ bus, storageProvider: storage, inboxClaimant });
  await service.start();

  assert.equal(emitted.length, 3, "all three pending items should reach the bus");
  assert.deepEqual(emitted.map((f) => f.body.eventId), ["evt_a", "evt_b", "evt_c"]);
  assert.deepEqual(emitted.map((f) => f.body.ciphertextB64), ["AA==", "BB==", "CC=="]);
  assert.equal(emitted.every((f) => f.body.mailboxId === INBOX), true);

  // Cursor persisted to last event.
  const persisted = await storage.kv.get("chat-server:inbox:catchup-cursor:v1:" + INBOX);
  assert.equal(persisted.lastEventId, "evt_c");
});

test("InboxCatchupService resumes from persisted cursor; never re-dispatches earlier items", async () => {
  const INBOX = "inbox:resume";
  const sdk = makeSdkWithMailbox({
    items: {
      [INBOX]: [
        { eventId: "evt_1", objectId: "o1", createdAt: 100 },
        { eventId: "evt_2", objectId: "o2", createdAt: 200 },
        { eventId: "evt_3", objectId: "o3", createdAt: 300 },
        { eventId: "evt_4", objectId: "o4", createdAt: 400 },
      ],
    },
    fetchByEventId: {
      [INBOX + "|evt_1"]: { ciphertextB64: "MQ==" },
      [INBOX + "|evt_2"]: { ciphertextB64: "Mg==" },
      [INBOX + "|evt_3"]: { ciphertextB64: "Mw==" },
      [INBOX + "|evt_4"]: { ciphertextB64: "NA==" },
    },
  });

  const bus = new ChatServerBus();
  bus.runtime.sdk = sdk;
  const storage = new MemStorage();
  // Pre-seed cursor at evt_2 — service should only emit evt_3 and evt_4.
  await new InboxCatchupCursor({ kvStore: storage.kv }).write(INBOX, "evt_2");

  const emitted = [];
  bus.on("runtime.event.mailbox.deposited", (frame) => emitted.push(frame));

  const service = new InboxCatchupService({
    bus,
    storageProvider: storage,
    inboxClaimant: { inboxId: INBOX },
  });
  await service.start();

  assert.deepEqual(emitted.map((f) => f.body.eventId), ["evt_3", "evt_4"],
    "cursor must skip evt_1 and evt_2; emit only later items");
  const persisted = await storage.kv.get("chat-server:inbox:catchup-cursor:v1:" + INBOX);
  assert.equal(persisted.lastEventId, "evt_4");
});

test("InboxCatchupService pages through multi-page nextCursor responses", async () => {
  const INBOX = "inbox:paged";
  const items = [];
  const fetchMap = {};
  for (let i = 0; i < 125; i++) {
    const eventId = "evt_" + String(i).padStart(4, "0");
    items.push({ eventId, objectId: "o" + i, createdAt: i });
    fetchMap[INBOX + "|" + eventId] = { ciphertextB64: "ZZZZ" };
  }

  const sdk = makeSdkWithMailbox({
    items: { [INBOX]: items },
    fetchByEventId: fetchMap,
  });

  const bus = new ChatServerBus();
  bus.runtime.sdk = sdk;
  const emitted = [];
  bus.on("runtime.event.mailbox.deposited", (frame) => emitted.push(frame));

  const service = new InboxCatchupService({
    bus,
    storageProvider: new MemStorage(),
    inboxClaimant: { inboxId: INBOX },
    pageLimit: 50,
  });
  await service.start();

  assert.equal(emitted.length, 125, "drain must continue across nextCursor pages until exhausted");
});

test("InboxCatchupService advances cursor even on a per-item basis (crash-safe high-water mark)", async () => {
  const INBOX = "inbox:crashsafe";
  const sdk = makeSdkWithMailbox({
    items: {
      [INBOX]: [
        { eventId: "evt_x", objectId: "o", createdAt: 1 },
        { eventId: "evt_y", objectId: "o", createdAt: 2 },
      ],
    },
    fetchByEventId: {
      [INBOX + "|evt_x"]: { ciphertextB64: "WA==" },
      [INBOX + "|evt_y"]: { ciphertextB64: "WQ==" },
    },
  });
  const storage = new MemStorage();
  const bus = new ChatServerBus();
  bus.runtime.sdk = sdk;

  // Stop after the first dispatch by un-subscribing the listener that would
  // (in production) drive downstream work — but cursor advance still happens
  // because it's per-item inside the drain loop.
  let count = 0;
  bus.on("runtime.event.mailbox.deposited", () => { count++; });

  const service = new InboxCatchupService({
    bus,
    storageProvider: storage,
    inboxClaimant: { inboxId: INBOX },
  });
  await service.start();
  assert.equal(count, 2);

  const persisted = await storage.kv.get("chat-server:inbox:catchup-cursor:v1:" + INBOX);
  assert.equal(persisted.lastEventId, "evt_y", "cursor must equal the last dispatched eventId, not the first");
});
