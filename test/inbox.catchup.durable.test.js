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
  // S15: the gap stops the CURSOR, not the PASS. seq 3 is perfectly decryptable and must be
  // delivered NOW rather than waiting behind seq 2 (previously up to the 30-minute quarantine
  // bound — the latency spike that made multi-device replies look broken).
  assert.deepEqual(emitted, [1, 2, 3], "every listed seq was submitted, including past the gap");

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

test("S15: a decryptable reply behind a blocked lower seq is delivered in the SAME pass", async () => {
  // The multi-device reply case, reduced: seq 1 cannot be consumed yet (its dependency has not
  // arrived), seq 2 is the reply and is perfectly decryptable. The reply must surface immediately;
  // the cursor must NOT advance past the seq that was never consumed.
  const INBOX = "inbox:s15";
  const cursorAckSpy = [];
  const sdk = makeDurableSdk({
    deposits: [
      { seq: 1, ciphertextB64: "AQ==" },
      { seq: 2, ciphertextB64: "Ag==" },
    ],
    cursorAckSpy,
  });
  const bus = new ChatServerBus();
  bus.runtime.sdk = sdk;

  let seq1Ready = false;
  const emitted = [];
  const service = new InboxCatchupService({
    bus,
    inboxClaimant: { inboxId: INBOX },
    inboundPipeline: makeSeqPipeline(
      (seq) => (seq === 1 ? { consumed: seq1Ready, decryptOk: seq1Ready } : { consumed: true, decryptOk: true }),
      emitted,
    ),
    processedLog: new ProcessedDepositLog({ kvStore: new MemKv() }),
  });

  await service.start();
  assert.ok(emitted.includes(2), "the reply was delivered despite the blocked seq below it");
  assert.equal(cursorAckSpy.length, 0, "and the cursor did NOT advance — seq 1 is still unconsumed");
  assert.equal(sdk.serverCursor(), 0, "the home keeps seq 1's ciphertext; nothing was pruned early");

  // Once the blocker clears, the watermark catches up in one pass.
  seq1Ready = true;
  await service.requestDrain();
  assert.deepEqual(cursorAckSpy.map((c) => c.throughSeq), [2], "contiguous advance to the head");
  assert.equal(sdk.serverCursor(), 2);
});

test("S15: the cursor never advances past a seq that was skipped, even if later seqs consume", async () => {
  // The safety property the change must not break: the watermark is the highest GAP-FREE consumed
  // seq. If it ever ran ahead, the home would prune ciphertext for a deposit we never applied.
  const INBOX = "inbox:s15-watermark";
  const cursorAckSpy = [];
  const sdk = makeDurableSdk({
    deposits: [
      { seq: 1, ciphertextB64: "AQ==" },
      { seq: 2, ciphertextB64: "Ag==" },
      { seq: 3, ciphertextB64: "Aw==" },
      { seq: 4, ciphertextB64: "BA==" },
    ],
    cursorAckSpy,
  });
  const bus = new ChatServerBus();
  bus.runtime.sdk = sdk;

  const emitted = [];
  const service = new InboxCatchupService({
    bus,
    inboxClaimant: { inboxId: INBOX },
    // seq 2 never consumes; 1, 3 and 4 do.
    inboundPipeline: makeSeqPipeline(
      (seq) => (seq === 2 ? { consumed: false, decryptOk: false } : { consumed: true, decryptOk: true }),
      emitted,
    ),
    processedLog: new ProcessedDepositLog({ kvStore: new MemKv() }),
  });

  await service.start();
  assert.deepEqual(emitted, [1, 2, 3, 4], "the whole page was offered to the pipeline");
  assert.deepEqual(cursorAckSpy.map((c) => c.throughSeq), [1], "watermark stops at the last gap-free seq");
  assert.equal(sdk.serverCursor(), 1, "3 and 4 applied, but the cursor stays below the gap");
});
