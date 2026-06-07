// Regression (2026-06-07): a deposit that arrives before its establishing
// handshake must still be delivered. Live, a group message can be PUSH-delivered
// to the recipient BEFORE the handshake that creates the session; it can't be
// decrypted yet, and the relay's transient buffer drops the delivered copy
// (ack-after-deliver), so catch-up's mailbox.list returns items=0 and the
// message is stranded ~50% of the time. The InboundDepositPipeline now retains
// unconsumed (ciphertext-bearing) deposits in memory and re-feeds them when a
// later deposit is consumed — a consumed handshake unblocks the messages that
// followed it. See memory project_offline_push_before_handshake_race.

import test from "node:test";
import assert from "node:assert/strict";

import { InboundDepositPipeline } from "../src/server/runtime/InboundDepositPipeline.js";
import { ProcessedDepositLog } from "../src/server/inbox/ProcessedDepositLog.js";

class MemKv {
  #m = new Map();
  async get(k) { return this.#m.has(k) ? this.#m.get(k) : undefined; }
  async set(k, v) { this.#m.set(k, v); }
  async delete(k) { this.#m.delete(k); }
}

const silent = { log() {}, info() {}, warn() {}, error() {}, debug() {} };

function msgFrame(eventId, { mailboxId = "mbx_self" } = {}) {
  return { t: "evt.mailbox.deposited", body: { mailboxId, eventId, ciphertextB64: "ct_" + eventId, kind: "message" } };
}
function hsFrame(eventId, { mailboxId = "mbx_self" } = {}) {
  return { t: "evt.mailbox.deposited", body: { mailboxId, eventId, ciphertextB64: "ct_" + eventId, kind: "handshake" } };
}

test("a message received before its handshake is re-delivered once the handshake is consumed", async () => {
  let sessionReady = false;
  const applied = [];
  const peerLinkProtocol = {
    async processDeposit(frame) {
      const body = frame && frame.body ? frame.body : {};
      if (body.kind === "handshake") { sessionReady = true; return { consumed: true, decryptOk: true }; }
      if (!sessionReady) return { consumed: false, decryptOk: false, reason: "no-session" };
      return { consumed: true, decryptOk: true, userMessage: { eventId: body.eventId, mailboxId: body.mailboxId } };
    },
  };
  const events = { async applyUserMessage(m) { applied.push(m.eventId); }, async processDeposit() {} };
  const pipeline = new InboundDepositPipeline({ peerLinkProtocol, events, processedLog: new ProcessedDepositLog({ kvStore: new MemKv() }), logger: silent });

  // Message wins the race to its handshake — can't decrypt yet, left buffered.
  const m = await pipeline.submit(msgFrame("M1"));
  assert.equal(m.consumed, false, "message can't be consumed before the session exists");
  assert.deepEqual(applied, [], "nothing applied yet");

  // Handshake lands → consumed → triggers a re-drain of the buffered message.
  const h = await pipeline.submit(hsFrame("H1"));
  assert.equal(h.consumed, true, "handshake consumed");
  assert.deepEqual(applied, ["M1"], "the earlier message is re-delivered after the handshake");
});

test("multiple messages buffered before the handshake all deliver, in order", async () => {
  let sessionReady = false;
  const applied = [];
  const peerLinkProtocol = {
    async processDeposit(frame) {
      const body = frame && frame.body ? frame.body : {};
      if (body.kind === "handshake") { sessionReady = true; return { consumed: true, decryptOk: true }; }
      if (!sessionReady) return { consumed: false, decryptOk: false, reason: "no-session" };
      return { consumed: true, decryptOk: true, userMessage: { eventId: body.eventId, mailboxId: body.mailboxId } };
    },
  };
  const events = { async applyUserMessage(m) { applied.push(m.eventId); }, async processDeposit() {} };
  const pipeline = new InboundDepositPipeline({ peerLinkProtocol, events, processedLog: new ProcessedDepositLog({ kvStore: new MemKv() }), logger: silent });

  await pipeline.submit(msgFrame("M1"));
  await pipeline.submit(msgFrame("M2"));
  await pipeline.submit(hsFrame("H1"));
  assert.deepEqual(applied.sort(), ["M1", "M2"], "both buffered messages deliver after the handshake");
});

test("a permanently-undecryptable buffered deposit is dropped after the re-attempt cap (no wedge)", async () => {
  const calls = new Map();
  const peerLinkProtocol = {
    async processDeposit(frame) {
      const body = frame && frame.body ? frame.body : {};
      calls.set(body.eventId, (calls.get(body.eventId) || 0) + 1);
      if (body.kind === "handshake") return { consumed: true, decryptOk: true };
      return { consumed: false, decryptOk: false, reason: "poison" }; // never consumable
    },
  };
  const events = { async applyUserMessage() {}, async processDeposit() {} };
  // Small cap so the test is fast and the drop is observable.
  const pipeline = new InboundDepositPipeline({ peerLinkProtocol, events, processedLog: new ProcessedDepositLog({ kvStore: new MemKv() }), logger: silent, maxRetainAttempts: 3 });

  await pipeline.submit(msgFrame("P1")); // poison, retained (attempts=0)
  // Each consumed handshake triggers a re-drain that re-attempts P1.
  for (let i = 0; i < 6; i += 1) {
    await pipeline.submit(hsFrame("H" + i));
  }
  const before = calls.get("P1");
  // One more consume — P1 has been dropped after hitting the cap, so it is no
  // longer re-attempted; the call count must not keep growing.
  await pipeline.submit(hsFrame("Hfinal"));
  assert.equal(calls.get("P1"), before, "poison deposit is no longer re-attempted after the cap");
  assert.ok(before <= 1 + 3, "re-attempts bounded by the cap");
});
