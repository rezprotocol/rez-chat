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
      return { userMessage: { eventId, mailboxId: f.body.mailboxId } };
    },
  };
  const events = {
    async applyUserMessage(m) { appliedMessages.push(m.eventId); },
    async processDeposit() {},
  };
  const processedLog = new ProcessedDepositLog({ kvStore: new MemKv() });
  const pipeline = new InboundDepositPipeline({ peerLinkProtocol, events, processedLog, logger: silent });

  // Live push consumes E1.
  await pipeline.submit(frame("E1"));
  // Catch-up re-fetches E1 (cold boot) — must be skipped, not re-decrypted.
  await pipeline.submit(frame("E1"));
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
      return null;
    },
  };
  const events = { async applyUserMessage() {}, async processDeposit() {} };
  const processedLog = new ProcessedDepositLog({ kvStore: new MemKv() });
  const pipeline = new InboundDepositPipeline({ peerLinkProtocol, events, processedLog, logger: silent });

  await pipeline.submit(frame("E9"));
  assert.equal(await processedLog.has("mbx_self", "E9"), false, "failed decrypt is not marked");
  await pipeline.submit(frame("E9"));
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
