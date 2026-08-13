// Regression: a deposit consumed live via the SDK push path must NOT be
// re-decrypted when the catch-up drain re-fetches it on a later cold boot.
// Re-decrypting fails the (already-advanced) double ratchet — observed
// 2026-06-04 as a group message sent while the recipient was offline never
// decrypting after relogin. The InboundDepositPipeline now dedups by
// (mailboxId, eventId) via a ProcessedDepositLog and skips the re-decrypt.

import test from "node:test";
import assert from "node:assert/strict";

import { InboundDepositPipeline } from "../src/server/runtime/InboundDepositPipeline.js";
import { ProcessedDepositLog } from "../src/server/inbox/ProcessedDepositLog.js";
import { depositIdentity } from "../src/server/runtime/depositIdentity.js";

class MemKv {
  #m = new Map();
  async get(k) { return this.#m.has(k) ? this.#m.get(k) : undefined; }
  async set(k, v) { this.#m.set(k, v); }
  async delete(k) { this.#m.delete(k); }
  size() { return this.#m.size; }
}

function frame(eventId, { mailboxId = "mbx_self" } = {}) {
  return { t: "evt.mailbox.deposited", body: { mailboxId, eventId, ciphertextB64: "ct_" + eventId } };
}

const silent = { log() {}, info() {}, warn() {}, error() {}, debug() {} };

test("pipeline skips re-decrypt of an already-processed (mailbox,event)", async () => {
  const decryptCalls = [];
  const appliedMessages = [];
  const peerLinkProtocol = {
    async processDeposit(f) {
      const eventId = f && f.body ? f.body.eventId : "";
      decryptCalls.push(eventId);
      return { consumed: true, decryptOk: true, userMessage: { eventId, mailboxId: f.body.mailboxId } };
    },
  };
  const events = {
    async applyUserMessage(m) { appliedMessages.push(m.eventId); },
    async processDeposit() {},
  };
  const processedLog = new ProcessedDepositLog({ kvStore: new MemKv() });
  const pipeline = new InboundDepositPipeline({ peerLinkProtocol, events, processedLog, logger: silent });

  // Live push consumes E1 — submit reports a successful decrypt.
  const r1 = await pipeline.submit(frame("E1"));
  assert.deepEqual(
    { decryptOk: r1.decryptOk, alreadyProcessed: r1.alreadyProcessed },
    { decryptOk: true, alreadyProcessed: false },
    "first submit reports decryptOk",
  );
  // Catch-up re-fetches E1 (cold boot) — must be skipped, reported as a dedup hit.
  const r1again = await pipeline.submit(frame("E1"));
  assert.deepEqual(
    { decryptOk: r1again.decryptOk, alreadyProcessed: r1again.alreadyProcessed },
    { decryptOk: false, alreadyProcessed: true },
    "re-fetch reports alreadyProcessed (still ack-able)",
  );
  // A genuinely-new offline deposit E2 is processed normally.
  await pipeline.submit(frame("E2"));

  assert.deepEqual(decryptCalls, ["E1", "E2"], "E1 decrypted once; the re-fetch is skipped; E2 decrypted");
  assert.deepEqual(appliedMessages, ["E1", "E2"], "only the first E1 and E2 are applied");
});

test("durable frames dedup on seq (no eventId) — S2 durable-mode catch-up re-list", async () => {
  // A durable node (S2) stamps a per-inbox monotonic `seq` and its catch-up
  // list items carry ONLY { seq, ciphertextB64 } — no relay eventId. The pipeline
  // must guard the non-idempotent re-decrypt on seq so a live-pushed-then-re-listed
  // deposit is not re-decrypted (which would fail the advanced ratchet).
  const decryptCalls = [];
  const peerLinkProtocol = {
    async processDeposit(f) {
      const seq = f && f.body ? f.body.seq : null;
      decryptCalls.push(seq);
      return { consumed: true, decryptOk: true, userMessage: { seq, mailboxId: f.body.mailboxId } };
    },
  };
  const applied = [];
  const events = { async applyUserMessage(m) { applied.push(m.seq); }, async processDeposit() {} };
  const processedLog = new ProcessedDepositLog({ kvStore: new MemKv() });
  const pipeline = new InboundDepositPipeline({ peerLinkProtocol, events, processedLog, logger: silent });
  const durable = (seq) => ({ t: "evt.mailbox.deposited", body: { mailboxId: "mbx_self", seq, ciphertextB64: "ct" + seq } });

  const r1 = await pipeline.submit(durable(1));            // live push of seq 1
  assert.deepEqual({ decryptOk: r1.decryptOk, alreadyProcessed: r1.alreadyProcessed }, { decryptOk: true, alreadyProcessed: false });
  const r1again = await pipeline.submit(durable(1));        // reconnect re-list of seq 1
  assert.deepEqual({ decryptOk: r1again.decryptOk, alreadyProcessed: r1again.alreadyProcessed }, { decryptOk: false, alreadyProcessed: true },
    "seq 1 re-list is a dedup hit, not a re-decrypt");
  await pipeline.submit(durable(2));                        // genuinely-new seq 2
  assert.deepEqual(decryptCalls, [1, 2], "seq 1 decrypted once; the re-list skipped; seq 2 decrypted");
  assert.deepEqual(applied, [1, 2]);
  assert.equal(await processedLog.has("mbx_self", "seq:1"), true, "dedup marker is keyed seq:1");
  assert.equal(await processedLog.has("mbx_self", "1"), false, "NOT keyed on the bare seq (no collision with a legacy eventId='1')");
});

test("durable catch-up seq is also the canonical application eventId", () => {
  const catchup = depositIdentity({
    body: { mailboxId: "mbx_self", seq: 7, ciphertextB64: "ciphertext" },
  });
  const live = depositIdentity({
    body: { mailboxId: "mbx_self", eventId: "node-local-event", seq: 7, ciphertextB64: "ciphertext" },
  });

  assert.deepEqual(catchup, { mailboxId: "mbx_self", eventId: "seq:7", seq: 7, dedupId: "seq:7" });
  assert.deepEqual(live, catchup, "live and catch-up delivery must reach decrypt/apply under one identity");
});

test("a decrypt failure is NOT marked processed (so it can be retried)", async () => {
  let attempts = 0;
  const peerLinkProtocol = {
    async processDeposit() {
      attempts += 1;
      if (attempts === 1) throw new Error("transient decrypt failure");
      return { consumed: true, decryptOk: true };
    },
  };
  const events = { async applyUserMessage() {}, async processDeposit() {} };
  const processedLog = new ProcessedDepositLog({ kvStore: new MemKv() });
  const pipeline = new InboundDepositPipeline({ peerLinkProtocol, events, processedLog, logger: silent });

  const failed = await pipeline.submit(frame("E9"));
  assert.deepEqual(
    { decryptOk: failed.decryptOk, alreadyProcessed: failed.alreadyProcessed },
    { decryptOk: false, alreadyProcessed: false },
    "failed decrypt reports decryptOk:false so the caller leaves it buffered",
  );
  assert.equal(await processedLog.has("mbx_self", "E9"), false, "failed decrypt is not marked");
  const retried = await pipeline.submit(frame("E9"));
  assert.equal(retried.decryptOk, true, "the retry now decrypts");
  assert.equal(attempts, 2, "a not-yet-processed event is retried on the next submit");
});

test("ProcessedDepositLog mark/has/forget round-trip and bounded pruning", async () => {
  const kv = new MemKv();
  const log = new ProcessedDepositLog({ kvStore: kv });
  assert.equal(await log.has("m", "e1"), false);
  await log.mark("m", "e1");
  assert.equal(await log.has("m", "e1"), true);
  assert.equal(kv.size(), 1);
  await log.forget("m", "e1");
  assert.equal(await log.has("m", "e1"), false);
  assert.equal(kv.size(), 0, "forget reclaims the marker");
  // Empty ids are a no-op (never throw, never persist).
  await log.mark("", "e");
  await log.mark("m", "");
  assert.equal(kv.size(), 0);
  assert.equal(await log.has("m", ""), false);
});

test("ProcessedDepositLog attempt counter increments, reads back, and clears (D1)", async () => {
  const log = new ProcessedDepositLog({ kvStore: new MemKv() });
  assert.equal(await log.attempts("m", "e"), 0, "no attempts initially");
  assert.equal(await log.recordAttempt("m", "e"), 1, "first attempt returns 1");
  assert.equal(await log.recordAttempt("m", "e"), 2, "second attempt returns 2");
  assert.equal(await log.attempts("m", "e"), 2, "reads back the running count");
  // Independent per (mailbox,event).
  assert.equal(await log.recordAttempt("m", "other"), 1, "separate event counts independently");
  await log.clearAttempts("m", "e");
  assert.equal(await log.attempts("m", "e"), 0, "clearAttempts resets the counter");
  assert.equal(await log.attempts("m", "other"), 1, "other event unaffected");
  // Empty ids are a no-op.
  assert.equal(await log.recordAttempt("", "e"), 0);
});
