import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { FsKeyValueStore } from "@rezprotocol/node";
import { InboundDepositPipeline } from "../src/server/runtime/InboundDepositPipeline.js";
import { InboundApplyOutbox } from "../src/server/inbox/InboundApplyOutbox.js";
import { ProcessedDepositLog } from "../src/server/inbox/ProcessedDepositLog.js";
import { InboxCatchupService } from "../src/server/services/InboxCatchupService.js";
import { ChatServerBus } from "../src/server/app/ChatServerBus.js";

// Audit P1.1 end-to-end: a decrypted message whose APPLICATION fails must NOT be
// lost when the durable cursor advances. The pipeline stages the plaintext in the
// apply-outbox before reporting it ack-safe (`durable:true`), and the retry pass
// applies it later (no re-decrypt) or retains it past the retry bound.

function makeKv() {
  const m = new Map();
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  return {
    async get(k) { return m.has(k) ? clone(m.get(k)) : undefined; },
    async getStrict(k) { return this.get(k); },
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
  return { pipeline, outbox, applied, kv, events, peerLinkProtocol };
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

test("a poison apply is retained and parked after the bound, never deleted or reported dropped", async () => {
  const { pipeline, outbox, applied } = makePipeline(() => "fail");
  await pipeline.submit(frame(7)); // stage + first apply failure (attempts=1)
  const retry = await pipeline.retryApplyOutbox(MBOX, { maxAttempts: 2, nowMs: 1000 });
  assert.deepEqual(retry.applied, []);
  assert.deepEqual(retry.quarantined, []);
  for (let i = 0; i < 5; i += 1) await pipeline.retryApplyOutbox(MBOX, { maxAttempts: 2 });
  assert.equal(applied.length, 2, "one ingress attempt plus one retry, then parked");
  const pending = await outbox.listPending(MBOX);
  assert.equal(pending.length, 1, "retained despite repeated drain requests");
  assert.equal(pending[0].userMessage.plaintextB64, "pt7");
});

test("parked outbox work recovers after restart when the application fault clears, without decrypting again", async () => {
  let mode = "fail";
  const { pipeline, outbox, applied, kv, events } = makePipeline(() => mode);
  await pipeline.submit(frame(7));
  await pipeline.retryApplyOutbox(MBOX, { maxAttempts: 2 });
  mode = "ok";
  await pipeline.retryApplyOutbox(MBOX, { maxAttempts: 2 });
  assert.equal(applied.length, 2, "clearing the fault alone does not unpark this runtime");
  const reopenedOutbox = new InboundApplyOutbox({ kvStore: kv });
  const restarted = new InboundDepositPipeline({
    outbox: reopenedOutbox,
    peerLinkProtocol: { async processDeposit() { assert.fail("restart must not re-decrypt"); } },
    events, logger: SILENT,
  });
  const result = await restarted.retryApplyOutbox(MBOX, { maxAttempts: 2 });
  assert.deepEqual(result.applied, ["seq:7"]);
  assert.deepEqual(result.quarantined, []);
  assert.equal(applied.length, 3);
  assert.deepEqual(await outbox.listPending(MBOX), [], "only successful application removes the work");
});

test("outbox parking is mailbox-scoped and does not block healthy entries", async () => {
  const { pipeline, outbox, applied } = makePipeline(msg => msg.mailboxId === MBOX && msg.eventId === "e7" ? "fail" : "ok");
  await pipeline.submit(frame(7));
  await pipeline.retryApplyOutbox(MBOX, { maxAttempts: 2 });
  await outbox.stage("inbox:b", "seq:7", { ...userMessage(7), mailboxId: "inbox:b" });
  await outbox.stage(MBOX, "seq:8", userMessage(8));
  assert.deepEqual((await pipeline.retryApplyOutbox("inbox:b", { maxAttempts: 2 })).applied, ["seq:7"]);
  assert.deepEqual((await pipeline.retryApplyOutbox(MBOX, { maxAttempts: 2 })).applied, ["seq:8"]);
  assert.equal(applied.length, 4);
  assert.equal((await outbox.listPending(MBOX)).length, 1);
});

test("catch-up with no UI retains over-bound outbox work and never emits a false dropped-message notice", async () => {
  const { pipeline, outbox } = makePipeline(() => "fail");
  await pipeline.submit(frame(7));
  const bus = new ChatServerBus({ logger: SILENT });
  bus.runtime.sdk = { mailbox: {
    async list() { return { items: [] }; },
    async fetch() { assert.fail("empty remote mailbox"); },
    async ack() { assert.fail("no remote deposit to settle"); },
  } };
  const catchup = new InboxCatchupService({ bus, inboxClaimant: { inboxId: MBOX },
    inboundPipeline: pipeline, maxDecryptAttempts: 2, periodicDrainMs: 0, logger: SILENT });
  await catchup.requestDrain();
  const notices = [];
  bus.on("mailbox.deposit.quarantined", notice => notices.push(notice));
  await catchup.requestDrain();
  assert.equal((await outbox.listPending(MBOX))[0].userMessage.plaintextB64, "pt7");
  assert.deepEqual(notices, []);
});

for (const cut of ["staged", "failure-persisted", "parked"]) {
  test("outbox plaintext survives abrupt process exit at " + cut + " and is applied after reopen", async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), "rez-outbox-retention-"));
    try {
      const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
        import { FsKeyValueStore } from ${JSON.stringify(import.meta.resolve("@rezprotocol/node"))};
        import { InboundApplyOutbox } from ${JSON.stringify(new URL("../src/server/inbox/InboundApplyOutbox.js", import.meta.url).href)};
        import { InboundDepositPipeline } from ${JSON.stringify(new URL("../src/server/runtime/InboundDepositPipeline.js", import.meta.url).href)};
        const outbox = new InboundApplyOutbox({ kvStore: new FsKeyValueStore({ rootDir: process.argv[1] }) });
        await outbox.stage("inbox:a", "seq:7", { eventId: "e7", mailboxId: "inbox:a", plaintextB64: "e30=" }, { nowMs: 1000 });
        if (process.argv[2] === "staged") process.exit(73);
        const recordFailure = outbox.recordApplyFailure.bind(outbox);
        outbox.recordApplyFailure = async (...args) => {
          const result = await recordFailure(...args);
          if (process.argv[2] === "failure-persisted" && result.attempts === 2) process.exit(73);
          return result;
        };
        const pipeline = new InboundDepositPipeline({ outbox,
          peerLinkProtocol: { async processDeposit() { throw new Error("must not decrypt"); } },
          events: { async applyUserMessage() { throw new Error("temporary storage fault"); }, async processDeposit() {} },
          logger: { error() {}, log() {} },
        });
        for (let i = 0; i < 4; i++) await pipeline.retryApplyOutbox("inbox:a", { maxAttempts: 2, nowMs: 2000 });
        process.exit(73);
      `, rootDir, cut], { encoding: "utf8", timeout: 20_000 });
      assert.equal(child.status, 73, child.stderr || String(child.error || "unexpected child exit"));
      const outbox = new InboundApplyOutbox({ kvStore: new FsKeyValueStore({ rootDir }) });
      const pending = await outbox.listPending(MBOX);
      assert.equal(pending.length, 1);
      assert.equal(pending[0].userMessage.plaintextB64, "e30=");
      assert.equal(pending[0].attempts, cut === "staged" ? 0 : 2);
      const applied = [];
      const restarted = new InboundDepositPipeline({ outbox,
        peerLinkProtocol: { async processDeposit() { assert.fail("must not decrypt after restart"); } },
        events: { async applyUserMessage(message) { applied.push(message); }, async processDeposit() {} },
        logger: SILENT,
      });
      assert.deepEqual((await restarted.retryApplyOutbox(MBOX, { maxAttempts: 2 })).applied, ["seq:7"]);
      assert.equal(applied.length, 1);
      assert.deepEqual(await outbox.listPending(MBOX), []);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
}

test("normal success applies and clears the outbox", async () => {
  const { pipeline, outbox, applied } = makePipeline(() => "ok");
  const res = await pipeline.submit(frame(9));
  assert.equal(res.durable, true);
  assert.equal(res.applied, true);
  assert.deepEqual(applied, ["e9"]);
  assert.equal((await outbox.listPending(MBOX)).length, 0, "applied → outbox empty");
});

// Audit P2 (staged-OR-applied): if STAGING fails but the apply SUCCEEDS, the
// message is durable (it's in the message store) and ack-safe — it must NOT be
// reported non-durable (which would stick the cursor, then doom a re-decrypt and
// wrongly surface a delivered message as poison).
test("stage-FAILURE + apply-success is durable (applied home), not poison", async () => {
  const kv = makeKv();
  // An outbox whose stage always throws (e.g. the durable KV is wedged), but
  // markApplied/recordApplyFailure/listPending behave normally.
  const realOutbox = new InboundApplyOutbox({ kvStore: kv });
  const outbox = {
    async stage() { throw new Error("stage boom"); },
    markApplied: (...a) => realOutbox.markApplied(...a),
    recordApplyFailure: (...a) => realOutbox.recordApplyFailure(...a),
    listPending: (...a) => realOutbox.listPending(...a),
  };
  const processedLog = new ProcessedDepositLog({ kvStore: kv });
  const applied = [];
  const events = {
    async applyUserMessage(msg) { applied.push(msg.eventId); },
    async processDeposit() {},
  };
  const peerLinkProtocol = {
    async processDeposit(f) {
      return { consumed: true, decryptOk: true, userMessage: userMessage(f.body.seq) };
    },
  };
  const pipeline = new InboundDepositPipeline({ peerLinkProtocol, events, processedLog, outbox, logger: SILENT });

  const res = await pipeline.submit(frame(5));
  assert.equal(res.durable, true, "applied to the message store ⇒ durable even though staging failed");
  assert.equal(res.applied, true, "the message WAS applied");
  assert.deepEqual(applied, ["e5"]);
  assert.deepEqual(await realOutbox.listPending(MBOX), [], "nothing left staged");
  // Marked processed ⇒ a redelivery dedups instead of doom-re-decrypting.
  assert.equal(await processedLog.has(MBOX, "seq:5"), true, "deduped on redelivery");
});

test("DT-302 durable work survives app failure and is replayed without re-decrypt", async () => {
  const work = {
    owner: "rez:acct:owner",
    sealedDigest: "ab".repeat(32),
    plaintextB64: "cHQ1",
    sourceMailboxId: MBOX,
    sourceEventId: "e5",
  };
  let mode = "fail";
  let decryptCalls = 0;
  const marked = [];
  const peerLinkProtocol = {
    async processDeposit() {
      decryptCalls += 1;
      return { consumed: true, decryptOk: true, deliveryWork: work, userMessage: userMessage(5) };
    },
    async listPendingDeliveryWork() { return marked.length === 0 ? [work] : []; },
    classifyDeliveryWork() { return { userMessage: userMessage(5) }; },
    async markDeliveryWorkApplied(sealedDigest) { marked.push(sealedDigest); },
  };
  const applied = [];
  const events = {
    async applyUserMessage(message) {
      applied.push(message.eventId);
      if (mode === "fail") throw new Error("apply boom");
    },
    async processDeposit() {},
  };
  const pipeline = new InboundDepositPipeline({ peerLinkProtocol, events, logger: SILENT });

  const first = await pipeline.submit(frame(5));
  assert.equal(first.durable, true, "the SDK work record authorizes cursor advance");
  assert.equal(first.applied, false);
  assert.deepEqual(marked, [], "failed app work remains pending");

  mode = "ok";
  const retry = await pipeline.retryApplyOutbox(MBOX);
  assert.deepEqual(retry.applied, ["delivery:" + work.sealedDigest]);
  assert.deepEqual(marked, [work.sealedDigest]);
  assert.equal(decryptCalls, 1, "recovery dispatches from work instead of touching ciphertext again");
});

test("DT-302 delivery-ack work is retried with authenticated sender authority", async () => {
  const work = { owner: "rez:acct:owner", sealedDigest: "cd".repeat(32) };
  const appliedAcks = [];
  const noted = [];
  const peerLinkProtocol = {
    async processDeposit() { return { consumed: false, decryptOk: false }; },
    async listPendingDeliveryWork() { return [work]; },
    classifyDeliveryWork() {
      return { deliveryAck: { senderAccountId: "rez:acct:peer", messageIds: ["mid:1"] } };
    },
    async markDeliveryWorkApplied(sealedDigest) { assert.equal(sealedDigest, work.sealedDigest); },
    noteDeliveryAckApplied(sender) { noted.push(sender); },
  };
  const pipeline = new InboundDepositPipeline({
    peerLinkProtocol,
    events: {
      async applyUserMessage() {},
      async processDeposit() {},
      async applyDeliveryAck(ack) { appliedAcks.push(ack); },
    },
    logger: SILENT,
  });
  const retry = await pipeline.retryApplyOutbox(MBOX);
  assert.deepEqual(appliedAcks, [{ senderAccountId: "rez:acct:peer", messageIds: ["mid:1"] }]);
  assert.deepEqual(noted, ["rez:acct:peer"]);
  assert.deepEqual(retry.applied, ["delivery:" + work.sealedDigest]);
});

test("DT-302 a permanently-failing durable work item is RETAINED past its retry bound — never dropped, never marked applied", async () => {
  const work = {
    owner: "rez:acct:owner",
    sealedDigest: "cd".repeat(32),
    plaintextB64: "cHQ5",
    sourceMailboxId: MBOX,
    sourceEventId: "e9",
    createdAtMs: 1_000,
  };
  const marked = [];
  let applyAttempts = 0;
  const peerLinkProtocol = {
    async processDeposit() { return { consumed: true, decryptOk: true }; },
    async listPendingDeliveryWork() { return marked.length === 0 ? [work] : []; },
    classifyDeliveryWork() { return { userMessage: userMessage(9) }; },
    async markDeliveryWorkApplied(sealedDigest) { marked.push(sealedDigest); },
  };
  const events = {
    async applyUserMessage() { applyAttempts += 1; throw new Error("permanently unappliable"); },
    async processDeposit() {},
  };
  const pipeline = new InboundDepositPipeline({ peerLinkProtocol, events, logger: SILENT });

  const opts = { maxAttempts: 3, maxAgeMs: 0, minAttemptsForAge: 0, nowMs: 2_000 };
  for (let i = 0; i < 6; i += 1) await pipeline.retryApplyOutbox(MBOX, opts);

  // Bounded: three real attempts this runtime, then parked.
  assert.equal(applyAttempts, 3, "retries stop at the bound for this runtime");
  // Retained: the work is NEVER marked applied, so the plaintext survives and
  // replay state never lies that it was delivered. A transient quarantine notice
  // is not a durable record; deleting first and notifying second was silent loss.
  assert.deepEqual(marked, [], "exceeding the bound must not delete the work");
  assert.deepEqual(await peerLinkProtocol.listPendingDeliveryWork(), [work], "still pending, still recoverable");
});

test("DT-302 a restart resets the per-runtime bound: the retained work is retried again, and still never deleted", async () => {
  const work = {
    owner: "rez:acct:owner",
    sealedDigest: "ab12".repeat(16),
    plaintextB64: "cHQ3",
    sourceMailboxId: MBOX,
    sourceEventId: "e7",
    createdAtMs: 1_000,
  };
  const marked = [];
  let applyAttempts = 0;
  const peerLinkProtocol = {
    async processDeposit() { return { consumed: true, decryptOk: true }; },
    async listPendingDeliveryWork() { return marked.length === 0 ? [work] : []; },
    classifyDeliveryWork() { return { userMessage: userMessage(7) }; },
    async markDeliveryWorkApplied(sealedDigest) { marked.push(sealedDigest); },
  };
  const events = {
    async applyUserMessage() { applyAttempts += 1; throw new Error("still failing"); },
    async processDeposit() {},
  };
  const opts = { maxAttempts: 2, maxAgeMs: 0, minAttemptsForAge: 0, nowMs: 2_000 };

  const first = new InboundDepositPipeline({ peerLinkProtocol, events, logger: SILENT });
  for (let i = 0; i < 4; i += 1) await first.retryApplyOutbox(MBOX, opts);
  assert.equal(applyAttempts, 2, "runtime 1: parked after the bound");

  // "Restart": a fresh pipeline has a fresh in-memory counter. This is the
  // behaviour the review probed — retention is indefinite across restarts,
  // and that is the deliberate safe direction until a durable disposition exists.
  const second = new InboundDepositPipeline({ peerLinkProtocol, events, logger: SILENT });
  for (let i = 0; i < 4; i += 1) await second.retryApplyOutbox(MBOX, opts);
  assert.equal(applyAttempts, 4, "runtime 2: retried again up to the bound");
  assert.deepEqual(marked, [], "across both runtimes the work was never deleted");
});

test("DT-302 the age bound cannot park durable work until the attempts floor is met", async () => {
  const work = {
    owner: "rez:acct:owner",
    sealedDigest: "ef".repeat(32),
    plaintextB64: "cHQ4",
    sourceMailboxId: MBOX,
    sourceEventId: "e8",
    createdAtMs: 0,
  };
  const marked = [];
  let applyAttempts = 0;
  const peerLinkProtocol = {
    async processDeposit() { return { consumed: true, decryptOk: true }; },
    async listPendingDeliveryWork() { return marked.length === 0 ? [work] : []; },
    classifyDeliveryWork() { return { userMessage: userMessage(8) }; },
    async markDeliveryWorkApplied(sealedDigest) { marked.push(sealedDigest); },
  };
  const events = {
    async applyUserMessage() { applyAttempts += 1; throw new Error("still failing"); },
    async processDeposit() {},
  };
  const pipeline = new InboundDepositPipeline({ peerLinkProtocol, events, logger: SILENT });

  // Wall clock is far past the age bound, but the item has had only one real
  // retry opportunity — the M5 rule: a suspended device accrues age with zero
  // attempts, and age alone must never be able to stop retrying a message.
  const opts = { maxAttempts: 0, maxAgeMs: 1_000, minAttemptsForAge: 3, nowMs: 999_999 };
  await pipeline.retryApplyOutbox(MBOX, opts);
  await pipeline.retryApplyOutbox(MBOX, opts);
  assert.equal(applyAttempts, 2, "age alone did not park it — still being retried");
  await pipeline.retryApplyOutbox(MBOX, opts);
  await pipeline.retryApplyOutbox(MBOX, opts);
  assert.equal(applyAttempts, 3, "once the floor is met, the age bound parks it");
  assert.deepEqual(marked, [], "and parking never deletes");
});
