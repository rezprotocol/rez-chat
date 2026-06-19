import test from "node:test";
import assert from "node:assert/strict";
import { InboundDepositPipeline } from "../src/server/runtime/InboundDepositPipeline.js";
import { InboundApplyOutbox } from "../src/server/inbox/InboundApplyOutbox.js";
import { ProcessedDepositLog } from "../src/server/inbox/ProcessedDepositLog.js";

// Audit P1.1 end-to-end: a decrypted message whose APPLICATION fails must NOT be
// lost when the durable cursor advances. The pipeline stages the plaintext in the
// apply-outbox before reporting it ack-safe (`durable:true`), and the retry pass
// applies it later (no re-decrypt) or surfaces a poison entry.

function makeKv() {
  const m = new Map();
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  return {
    async get(k) { return m.has(k) ? clone(m.get(k)) : undefined; },
    async set(k, v) { m.set(k, clone(v)); },
    async delete(k) { return m.delete(k); },
  };
}

const MBOX = "inbox:a";
const SILENT = { error() {}, log() {} };

function frame(seq) {
  return { t: "evt.mailbox.deposited", body: { mailboxId: MBOX, seq, ciphertextB64: "ct" + seq } };
}
function userMessage(seq) {
  return { eventId: "e" + seq, plaintextB64: "pt" + seq, mailboxId: MBOX, senderAccountId: "rez:acct:peer" };
}

function makePipeline(applyBehavior) {
  const kv = makeKv();
  const outbox = new InboundApplyOutbox({ kvStore: kv });
  const processedLog = new ProcessedDepositLog({ kvStore: kv });
  const applied = [];
  const events = {
    async applyUserMessage(msg) {
      applied.push(msg.eventId);
      if (applyBehavior(msg) === "fail") throw new Error("apply boom");
    },
    async processDeposit() {},
  };
  const peerLinkProtocol = {
    async processDeposit(f) {
      return { consumed: true, decryptOk: true, userMessage: userMessage(f.body.seq) };
    },
  };
  const pipeline = new InboundDepositPipeline({ peerLinkProtocol, events, processedLog, outbox, logger: SILENT });
  return { pipeline, outbox, applied };
}

test("decrypt-success + apply-FAILURE is durable (ack-safe) but staged — NOT lost", async () => {
  const { pipeline, outbox } = makePipeline(() => "fail");
  const res = await pipeline.submit(frame(5));
  assert.equal(res.durable, true, "ack-safe: the plaintext is durably staged, so advancing the cursor is OK");
  assert.equal(res.applied, false, "application failed");
  const pending = await outbox.listPending(MBOX);
  assert.deepEqual(pending.map((e) => e.dedupId), ["seq:5"]);
  assert.equal(pending[0].userMessage.plaintextB64, "pt5", "the decrypted payload is recoverable from the outbox");
});

test("a staged payload is retried and applied from the outbox (no re-decrypt)", async () => {
  let mode = "fail";
  const { pipeline, outbox } = makePipeline(() => mode);
  await pipeline.submit(frame(5));
  assert.equal((await outbox.listPending(MBOX)).length, 1);

  mode = "ok"; // the durable store recovers
  const retry = await pipeline.retryApplyOutbox(MBOX, { maxAttempts: 12 });
  assert.deepEqual(retry.applied, ["seq:5"]);
  assert.deepEqual(retry.quarantined, []);
  assert.equal((await outbox.listPending(MBOX)).length, 0, "removed once applied");
});

test("a poison apply is quarantined after the bound (surfaced, never retried forever)", async () => {
  const { pipeline, outbox } = makePipeline(() => "fail");
  await pipeline.submit(frame(7)); // stage + first apply failure (attempts=1)
  const retry = await pipeline.retryApplyOutbox(MBOX, { maxAttempts: 2, nowMs: 1000 });
  assert.deepEqual(retry.applied, []);
  assert.equal(retry.quarantined.length, 1);
  assert.equal(retry.quarantined[0].dedupId, "seq:7");
  assert.equal(retry.quarantined[0].reason, "attempts");
  assert.equal((await outbox.listPending(MBOX)).length, 0, "poison entry dropped — bounded, surfaced via quarantine");
});

test("normal success applies and clears the outbox", async () => {
  const { pipeline, outbox, applied } = makePipeline(() => "ok");
  const res = await pipeline.submit(frame(9));
  assert.equal(res.durable, true);
  assert.equal(res.applied, true);
  assert.deepEqual(applied, ["e9"]);
  assert.equal((await outbox.listPending(MBOX)).length, 0, "applied → outbox empty");
});
