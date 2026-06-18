// S2 Slice 4 — durable-mode catch-up. Against a durable-capable node the drain
// lists inline { seq, ciphertextB64 } from the SERVER-held device cursor and
// advances it via mailbox.cursorAck through the highest CONTIGUOUS consumed seq —
// NO fetch (bodies inline), NO ack-delete (the home log is durable). A gap stops
// the cursor below it; a poison seq is quarantined by cursor-skipping past it AND
// surfacing a user-visible notice (never silently dropped).

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

// Durable node mock: advertises the durableInbox capability, holds the device
// cursor server-side, list() returns seq strictly > cursor inline, cursorAck()
// advances the cursor monotonically. Deliberately has NO fetch/ack — if the
// durable path ever called them the test would throw (proves the model).
function makeDurableSdk({ deposits, listSpy, cursorAckSpy }) {
  let cursor = 0;
  return {
    connectivity: { onReconnected() { return () => {}; } },
    getSessionInfo() { return { capabilities: { durableInbox: true } }; },
    mailbox: {
      async list({ mailboxId, limit }) {
        if (listSpy) listSpy.push({ mailboxId, limit });
        const after = deposits.filter((d) => d.seq > cursor).slice(0, limit || 50);
        return { items: after.map((d) => ({ seq: d.seq, ciphertextB64: d.ciphertextB64 })), nextCursor: null };
      },
      async cursorAck({ mailboxId, throughSeq }) {
        if (cursorAckSpy) cursorAckSpy.push({ mailboxId, throughSeq });
        if (Number.isInteger(throughSeq) && throughSeq > cursor) cursor = throughSeq;
        return { mailboxId, lastSeq: cursor };
      },
    },
    serverCursor() { return cursor; },
  };
}

function makeSeqPipeline(resultForSeq, log) {
  return {
    submit(frame) {
      const seq = frame && frame.body ? frame.body.seq : null;
      if (log) log.push(seq);
      const r = resultForSeq(seq) || {};
      return Promise.resolve({
        consumed: Boolean(r.consumed),
        decryptOk: Boolean(r.decryptOk),
        alreadyProcessed: Boolean(r.alreadyProcessed),
        applied: r.applied !== false,
      });
    },
  };
}
const okSeq = () => ({ consumed: true, decryptOk: true });

test("durable drain: contiguous consume advances the cursor via cursorAck (no fetch, no ack-delete)", async () => {
  const INBOX = "inbox:durable";
  const listSpy = [];
  const cursorAckSpy = [];
  const sdk = makeDurableSdk({
    deposits: [
      { seq: 1, ciphertextB64: "AQ==" },
      { seq: 2, ciphertextB64: "Ag==" },
      { seq: 3, ciphertextB64: "Aw==" },
    ],
    listSpy, cursorAckSpy,
  });
  const bus = new ChatServerBus();
  bus.runtime.sdk = sdk;
  const emitted = [];
  const service = new InboxCatchupService({
    bus,
    inboxClaimant: { inboxId: INBOX },
    inboundPipeline: makeSeqPipeline(okSeq, emitted),
    processedLog: new ProcessedDepositLog({ kvStore: new MemKv() }),
  });
  await service.start();

  assert.deepEqual(emitted, [1, 2, 3], "all deposits feed the pipeline in seq order");
  assert.deepEqual(cursorAckSpy.map((c) => c.throughSeq), [3], "cursor advanced once to the highest contiguous seq");
  assert.equal(sdk.serverCursor(), 3, "server-held cursor now at 3");

  // A reconnect drain finds nothing new (cursor is caught up) and does not re-ack.
  cursorAckSpy.length = 0;
  await service.requestDrain();
  assert.deepEqual(cursorAckSpy, [], "caught-up reconnect drain is a no-op");
});

test("durable drain: a gap (undecryptable seq) stops the cursor below it and redelivers on the next drain", async () => {
  const INBOX = "inbox:gap";
  const cursorAckSpy = [];
  const sdk = makeDurableSdk({
    deposits: [
      { seq: 1, ciphertextB64: "AQ==" },
      { seq: 2, ciphertextB64: "Ag==" },
      { seq: 3, ciphertextB64: "Aw==" },
    ],
    cursorAckSpy,
  });
  const bus = new ChatServerBus();
  bus.runtime.sdk = sdk;

  let seq2Decrypts = false;
  const resultFor = (seq) => (seq === 2
    ? { consumed: seq2Decrypts, decryptOk: seq2Decrypts }
    : { consumed: true, decryptOk: true });
  const emitted = [];
  const service = new InboxCatchupService({
    bus,
    inboxClaimant: { inboxId: INBOX },
    inboundPipeline: makeSeqPipeline(resultFor, emitted),
    processedLog: new ProcessedDepositLog({ kvStore: new MemKv() }),
  });

  await service.start();
  assert.deepEqual(cursorAckSpy.map((c) => c.throughSeq), [1], "cursor advances only through the contiguous prefix (seq 1)");
  assert.equal(sdk.serverCursor(), 1, "seq 2 gap holds the server cursor at 1 — seq 3 not yet consumed");

  // The gap's dependency arrives; the next drain re-lists from seq 2 and completes.
  seq2Decrypts = true;
  cursorAckSpy.length = 0;
  await service.requestDrain();
  assert.deepEqual(cursorAckSpy.map((c) => c.throughSeq), [3], "cursor advances to 3 once the gap fills");
  assert.equal(sdk.serverCursor(), 3, "fully caught up");
});

test("durable drain: a poison seq is QUARANTINED by cursor-skip AND surfaced (never silently dropped)", async () => {
  const INBOX = "inbox:poison";
  const cursorAckSpy = [];
  const sdk = makeDurableSdk({
    deposits: [
      { seq: 1, ciphertextB64: "AQ==" },
      { seq: 2, ciphertextB64: "Ag==" }, // poison — never decrypts
      { seq: 3, ciphertextB64: "Aw==" },
    ],
    cursorAckSpy,
  });
  const bus = new ChatServerBus();
  bus.runtime.sdk = sdk;
  const quarantined = [];
  bus.on("mailbox.deposit.quarantined", (e) => quarantined.push(e));

  const resultFor = (seq) => (seq === 2 ? { decryptOk: false } : { consumed: true, decryptOk: true });
  const service = new InboxCatchupService({
    bus,
    inboxClaimant: { inboxId: INBOX },
    inboundPipeline: makeSeqPipeline(resultFor),
    processedLog: new ProcessedDepositLog({ kvStore: new MemKv() }),
    maxDecryptAttempts: 3,
  });

  await service.start();          // attempt 1 on seq 2 → blocked; cursor at 1
  assert.equal(sdk.serverCursor(), 1);
  await service.requestDrain();   // attempt 2 → still blocked; cursor at 1
  assert.equal(sdk.serverCursor(), 1, "poison seq holds the cursor while under the attempt bound");
  assert.equal(quarantined.length, 0, "not surfaced until the bound fires");
  await service.requestDrain();   // attempt 3 → quarantine: skip past seq 2, deliver seq 3

  assert.equal(sdk.serverCursor(), 3, "cursor-skips the poison seq so seq 3 is delivered (no permanent wedge)");
  assert.equal(quarantined.length, 1, "the dropped deposit is surfaced exactly once");
  assert.equal(quarantined[0].seq, 2, "the quarantine notice identifies the dropped seq");
  assert.equal(quarantined[0].reason, "attempts", "reason recorded");
  assert.equal(quarantined[0].attempts, 3, "attempt count recorded");
  assert.equal(String(quarantined[0].eventId || ""), "", "no eventId in durable mode (seq identifies it)");
});
