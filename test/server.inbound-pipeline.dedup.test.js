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
