import test from "node:test";
import assert from "node:assert/strict";
import { InboxCatchupService } from "../src/server/services/InboxCatchupService.js";
import { ProcessedDepositLog } from "../src/server/inbox/ProcessedDepositLog.js";
import { ChatServerBus } from "../src/server/app/ChatServerBus.js";

class MemKv {
  constructor() { this.data = new Map(); }
  async get(key) { return this.data.has(key) ? this.data.get(key) : null; }
  async set(key, value) { this.data.set(key, value); }
  async delete(key) { this.data.delete(key); }
}

// In-memory mailbox that mirrors RMailbox semantics the drain depends on:
// list() returns events whose eventId sorts strictly AFTER the cursor string
// (tolerant of acked/removed ids — the cursor is a boundary, not an index), and
// ack() deletes the event from the buffer.
function makeSdkWithMailbox({ items, fetchByEventId, listSpy, fetchSpy, ackSpy }) {
  return {
    connectivity: { onReconnected() { return () => {}; } },
    mailbox: {
      async list({ mailboxId, cursor, limit }) {
        if (listSpy) listSpy.push({ mailboxId, cursor, limit });
        const all = (items[mailboxId] || []).slice().sort((a, b) => (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0));
        const after = cursor ? all.filter((i) => i.eventId > cursor) : all;
        const sliced = after.slice(0, limit || 50);
        const last = sliced.length ? sliced[sliced.length - 1].eventId : null;
        const nextCursor = after.length - sliced.length > 0 ? last : null;
        return { items: sliced, nextCursor };
      },
      async fetch({ mailboxId, eventId }) {
        if (fetchSpy) fetchSpy.push({ mailboxId, eventId });
        return fetchByEventId[mailboxId + "|" + eventId] || null;
      },
      async ack({ mailboxId, eventId }) {
        if (ackSpy) ackSpy.push({ mailboxId, eventId });
        const arr = items[mailboxId] || [];
        const idx = arr.findIndex((i) => i.eventId === eventId);
        if (idx >= 0) arr.splice(idx, 1);
        return { mailboxId, eventId, removed: idx >= 0 };
      },
    },
  };
}

// Pipeline stub: resultFor(eventId) -> { consumed, decryptOk, alreadyProcessed }.
function makePipeline(resultFor, log) {
  return {
    submit(frame) {
      const eventId = frame && frame.body ? frame.body.eventId : "";
      if (log) log.push(frame);
      const r = resultFor(eventId) || {};
      return Promise.resolve({
        consumed: Boolean(r.consumed),
        decryptOk: Boolean(r.decryptOk),
        alreadyProcessed: Boolean(r.alreadyProcessed),
        applied: r.applied !== false,
      });
    },
  };
}

const ok = () => ({ consumed: true, decryptOk: true });

test("InboxCatchupService drains all pending items and ACKs them on first start", async () => {
  const INBOX = "inbox:owner";
  const listSpy = [];
  const fetchSpy = [];
  const ackSpy = [];
  const items = {
    [INBOX]: [
      { eventId: "evt_a", objectId: "o1", createdAt: 100 },
      { eventId: "evt_b", objectId: "o2", createdAt: 200 },
      { eventId: "evt_c", objectId: "o3", createdAt: 300 },
    ],
  };
  const sdk = makeSdkWithMailbox({
    items,
    fetchByEventId: {
      [INBOX + "|evt_a"]: { ciphertextB64: "AA==" },
      [INBOX + "|evt_b"]: { ciphertextB64: "BB==" },
      [INBOX + "|evt_c"]: { ciphertextB64: "CC==" },
    },
    listSpy, fetchSpy, ackSpy,
  });

  const bus = new ChatServerBus();
  bus.runtime.sdk = sdk;
  const emitted = [];
  const service = new InboxCatchupService({
    bus,
    inboxClaimant: { inboxId: INBOX },
    inboundPipeline: makePipeline(ok, emitted),
    processedLog: new ProcessedDepositLog({ kvStore: new MemKv() }),
  });
  await service.start();

  assert.deepEqual(emitted.map((f) => f.body.eventId), ["evt_a", "evt_b", "evt_c"], "all reach pipeline, in order");
  assert.deepEqual(emitted.map((f) => f.body.ciphertextB64), ["AA==", "BB==", "CC=="]);
  assert.deepEqual(ackSpy.map((a) => a.eventId), ["evt_a", "evt_b", "evt_c"], "every consumed deposit is acked");
  assert.equal(items[INBOX].length, 0, "buffer drains to empty");
});

test("InboxCatchupService LEAVES an undecryptable deposit buffered and retries on the next drain (regression: no permanent stranding)", async () => {
  const INBOX = "inbox:retry";
  const ackSpy = [];
  const items = {
    [INBOX]: [
      { eventId: "evt_1", objectId: "o1", createdAt: 1 },
      { eventId: "evt_2", objectId: "o2", createdAt: 2 },
    ],
  };
  const sdk = makeSdkWithMailbox({
    items,
    fetchByEventId: {
      [INBOX + "|evt_1"]: { ciphertextB64: "MQ==" },
      [INBOX + "|evt_2"]: { ciphertextB64: "Mg==" },
    },
    ackSpy,
  });
  const bus = new ChatServerBus();
  bus.runtime.sdk = sdk;

  // evt_2 cannot decrypt yet (e.g. its handshake hasn't been applied).
  let evt2Decrypts = false;
  const resultFor = (eventId) => (eventId === "evt_2"
    ? { consumed: evt2Decrypts, decryptOk: evt2Decrypts }
    : { consumed: true, decryptOk: true });

  const service = new InboxCatchupService({
    bus,
    inboxClaimant: { inboxId: INBOX },
    inboundPipeline: makePipeline(resultFor),
    processedLog: new ProcessedDepositLog({ kvStore: new MemKv() }),
  });
  await service.start();

  assert.deepEqual(ackSpy.map((a) => a.eventId), ["evt_1"], "only the decryptable deposit is acked");
  assert.deepEqual(items[INBOX].map((i) => i.eventId), ["evt_2"], "the undecryptable deposit stays buffered for retry");

  // Now its dependency is in place; the next drain decrypts + acks it.
  evt2Decrypts = true;
  await service.requestDrain();
  assert.deepEqual(ackSpy.map((a) => a.eventId), ["evt_1", "evt_2"], "evt_2 is acked once it decrypts");
  assert.equal(items[INBOX].length, 0, "buffer fully drained after recovery");
});

test("InboxCatchupService quarantines a poison deposit after maxDecryptAttempts (D1)", async () => {
  const INBOX = "inbox:poison";
  const ackSpy = [];
  const items = { [INBOX]: [{ eventId: "evt_p", objectId: "o", createdAt: 1 }] };
  const sdk = makeSdkWithMailbox({
    items,
    fetchByEventId: { [INBOX + "|evt_p"]: { ciphertextB64: "UA==" } },
    ackSpy,
  });
  const bus = new ChatServerBus();
  bus.runtime.sdk = sdk;

  const service = new InboxCatchupService({
    bus,
    inboxClaimant: { inboxId: INBOX },
    inboundPipeline: makePipeline(() => ({ decryptOk: false })),
    processedLog: new ProcessedDepositLog({ kvStore: new MemKv() }),
    maxDecryptAttempts: 3,
  });

  await service.start();        // attempt 1 — left buffered
  assert.equal(items[INBOX].length, 1, "still buffered after attempt 1");
  await service.requestDrain(); // attempt 2 — left buffered
  assert.equal(items[INBOX].length, 1, "still buffered after attempt 2");
  await service.requestDrain(); // attempt 3 — quarantined (acked + dropped)
  assert.deepEqual(ackSpy.map((a) => a.eventId), ["evt_p"], "poison deposit acked on quarantine");
  assert.equal(items[INBOX].length, 0, "poison deposit removed so it can't wedge the drain");
});

test("InboxCatchupService acks a dedup hit (already consumed via live push) without requiring a fresh decrypt", async () => {
  const INBOX = "inbox:dedup";
  const ackSpy = [];
  const items = { [INBOX]: [{ eventId: "evt_d", objectId: "o", createdAt: 1 }] };
  const sdk = makeSdkWithMailbox({
    items,
    fetchByEventId: { [INBOX + "|evt_d"]: { ciphertextB64: "RA==" } },
    ackSpy,
  });
  const bus = new ChatServerBus();
  bus.runtime.sdk = sdk;

  const service = new InboxCatchupService({
    bus,
    inboxClaimant: { inboxId: INBOX },
    inboundPipeline: makePipeline(() => ({ decryptOk: false, alreadyProcessed: true })),
    processedLog: new ProcessedDepositLog({ kvStore: new MemKv() }),
  });
  await service.start();

  assert.deepEqual(ackSpy.map((a) => a.eventId), ["evt_d"], "dedup hit is acked (buffer copy is redundant)");
  assert.equal(items[INBOX].length, 0, "buffer drained");
});

test("InboxCatchupService pages across nextCursor responses and acks every item", async () => {
  const INBOX = "inbox:paged";
  const items = [];
  const fetchMap = {};
  for (let i = 0; i < 125; i++) {
    const eventId = "evt_" + String(i).padStart(4, "0");
    items.push({ eventId, objectId: "o" + i, createdAt: i });
    fetchMap[INBOX + "|" + eventId] = { ciphertextB64: "ZZZZ" };
  }
  const ackSpy = [];
  const buffer = { [INBOX]: items };
  const sdk = makeSdkWithMailbox({ items: buffer, fetchByEventId: fetchMap, ackSpy });

  const bus = new ChatServerBus();
  bus.runtime.sdk = sdk;
  const emitted = [];
  const service = new InboxCatchupService({
    bus,
    inboxClaimant: { inboxId: INBOX },
    pageLimit: 50,
    inboundPipeline: makePipeline(ok, emitted),
    processedLog: new ProcessedDepositLog({ kvStore: new MemKv() }),
  });
  await service.start();

  assert.equal(emitted.length, 125, "drain continues across nextCursor pages until exhausted");
  assert.equal(ackSpy.length, 125, "every item acked");
  assert.equal(buffer[INBOX].length, 0, "buffer fully drained");
});
