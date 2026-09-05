// M5 (plans/MOBILE_LIFECYCLE_ADAPTER_PLAN.md, approved ruling) — the
// quarantine AGE bound gets an attempts floor (3). The T4 hazard this pins:
// the age bound counts WALL-CLOCK time, which on a suspended phone elapses
// entirely while the app is dead. Before M5, a deposit that first-failed just
// before suspension was quarantined (dropped) on its FIRST post-wake attempt
// with zero real retries. Suspended time is not retry time: age may only
// quarantine a deposit that has had real decode/apply opportunities. The
// attempts bound (8) is untouched and still catches independently.

import test from "node:test";
import assert from "node:assert/strict";
import { InboxCatchupService } from "../src/server/services/InboxCatchupService.js";
import { InboundDepositPipeline } from "../src/server/runtime/InboundDepositPipeline.js";
import { InboundApplyOutbox } from "../src/server/inbox/InboundApplyOutbox.js";
import { ProcessedDepositLog } from "../src/server/inbox/ProcessedDepositLog.js";
import { ChatServerBus } from "../src/server/app/ChatServerBus.js";

const QUIET = { error() {}, warn() {}, info() {}, log() {} };

class MemKv {
  constructor() { this.data = new Map(); }
  async get(key) { return this.data.has(key) ? this.data.get(key) : null; }
  async set(key, value) { this.data.set(key, value); }
  async delete(key) { this.data.delete(key); }
}

function makeSdkWithMailbox({ items, fetchByEventId, ackSpy }) {
  return {
    connectivity: { onReconnected() { return () => {}; } },
    mailbox: {
      async list({ mailboxId, cursor, limit }) {
        const all = (items[mailboxId] || []).slice().sort((a, b) => (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0));
        const after = cursor ? all.filter((i) => i.eventId > cursor) : all;
        const sliced = after.slice(0, limit || 50);
        const last = sliced.length ? sliced[sliced.length - 1].eventId : null;
        const nextCursor = after.length - sliced.length > 0 ? last : null;
        return { items: sliced, nextCursor };
      },
      async fetch({ mailboxId, eventId }) {
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

const failingPipeline = {
  submit() {
    return Promise.resolve({ consumed: false, decryptOk: false, alreadyProcessed: false });
  },
};

test("M5 (the mobile case): 30 days of suspended wall-clock CANNOT quarantine on the first post-wake attempts — age fires only once 3 real attempts ran", async () => {
  const INBOX = "inbox:suspended";
  const ackSpy = [];
  const emittedQuarantines = [];
  const items = { [INBOX]: [{ eventId: "evt_x", objectId: "o", createdAt: 1 }] };
  const sdk = makeSdkWithMailbox({ items, fetchByEventId: { [INBOX + "|evt_x"]: { ciphertextB64: "UA==" } }, ackSpy });
  const bus = new ChatServerBus({ config: {}, logger: QUIET });
  bus.runtime.sdk = sdk;
  bus.on("mailbox.deposit.quarantined", (e) => emittedQuarantines.push(e));

  let now = 1_000_000;
  const service = new InboxCatchupService({
    bus,
    inboxClaimant: { inboxId: INBOX },
    inboundPipeline: failingPipeline,
    processedLog: new ProcessedDepositLog({ kvStore: new MemKv() }),
    maxDecryptAttempts: 100,     // attempt bound out of the way
    maxQuarantineAgeMs: 60_000,  // 1 min age bound (test-scaled)
    clock: () => now,
    logger: QUIET,
  });

  await service.start();            // attempt 1 — anchors firstSeenAtMs, then "suspension"
  now += 30 * 24 * 60 * 60 * 1000;  // 30 days dark: age is enormous, attempts are not

  await service.requestDrain();     // attempt 2 — the FIRST post-wake attempt
  assert.equal(items[INBOX].length, 1, "pre-M5 this was the drop: age alone must NOT quarantine at 2 attempts");
  assert.deepEqual(ackSpy, []);

  await service.requestDrain();     // attempt 3 — the floor is met; age may now fire
  assert.deepEqual(ackSpy.map((a) => a.eventId), ["evt_x"], "quarantined once real attempts proved poison");
  assert.equal(emittedQuarantines.length, 1, "surfaced, never silent");
  assert.equal(emittedQuarantines[0].reason, "age");
  assert.ok(emittedQuarantines[0].attempts >= 3);
});

test("M5: the attempts bound (8) is untouched — a flood still quarantines fast regardless of age", async () => {
  const INBOX = "inbox:flood";
  const ackSpy = [];
  const items = { [INBOX]: [{ eventId: "evt_f", objectId: "o", createdAt: 1 }] };
  const sdk = makeSdkWithMailbox({ items, fetchByEventId: { [INBOX + "|evt_f"]: { ciphertextB64: "UA==" } }, ackSpy });
  const bus = new ChatServerBus({ config: {}, logger: QUIET });
  bus.runtime.sdk = sdk;

  let now = 1_000_000;
  const service = new InboxCatchupService({
    bus,
    inboxClaimant: { inboxId: INBOX },
    inboundPipeline: failingPipeline,
    processedLog: new ProcessedDepositLog({ kvStore: new MemKv() }),
    maxDecryptAttempts: 2,            // reachable fast
    maxQuarantineAgeMs: 60 * 60_000,  // age bound far away
    clock: () => now,
    logger: QUIET,
  });

  await service.start();        // attempt 1
  await service.requestDrain(); // attempt 2 → attempts bound
  assert.deepEqual(ackSpy.map((a) => a.eventId), ["evt_f"], "attempt-bound quarantine unaffected by the floor");
});

// ---- The apply-outbox mirror (same knobs, same floor) ----

const MBOX = "inbox:a";
function frame(seq) {
  return { t: "evt.mailbox.deposited", body: { mailboxId: MBOX, seq, ciphertextB64: "ct" + seq } };
}

function makeApplyPipeline() {
  const kv = new MemKv();
  const outbox = new InboundApplyOutbox({ kvStore: kv });
  const processedLog = new ProcessedDepositLog({ kvStore: kv });
  const events = {
    async applyUserMessage() { throw new Error("apply boom"); },
    async processDeposit() {},
  };
  const peerLinkProtocol = {
    async processDeposit(f) {
      return {
        consumed: true,
        decryptOk: true,
        userMessage: { eventId: "e" + f.body.seq, plaintextB64: "pt", mailboxId: MBOX, senderAccountId: "rez:acct:peer" },
      };
    },
  };
  const pipeline = new InboundDepositPipeline({ peerLinkProtocol, events, processedLog, outbox, logger: QUIET });
  return { pipeline, outbox };
}

test("M5 apply-outbox: the attempts floor delays parking and age never authorizes deletion", async () => {
  const { pipeline, outbox } = makeApplyPipeline();
  await pipeline.submit(frame(7)); // stage + apply failure (attempts=1), staged at Date.now()

  // A retry pass a "month" later: age is over any bound, attempts are not.
  const farFuture = Date.now() + 30 * 24 * 60 * 60 * 1000;
  const bounds = { maxAttempts: 100, maxAgeMs: 60_000, minAttemptsForAge: 3, nowMs: farFuture };

  let retry = await pipeline.retryApplyOutbox(MBOX, bounds);        // attempts → 2
  assert.deepEqual(retry.quarantined, [], "age alone must not drop a barely-tried entry");
  assert.equal((await outbox.listPending(MBOX)).length, 1, "still staged, still recoverable");

  retry = await pipeline.retryApplyOutbox(MBOX, bounds);            // attempts → 3: floor met
  assert.deepEqual(retry.quarantined, []);
  assert.equal((await outbox.listPending(MBOX)).length, 1, "retained once the floor parks it");
  await pipeline.retryApplyOutbox(MBOX, bounds);
  assert.equal((await outbox.listPending(MBOX))[0].attempts, 3, "parked without another application attempt");
});

test("M5 apply-outbox: omitting the floor lets age park work but never delete it", async () => {
  const { pipeline, outbox } = makeApplyPipeline();
  await pipeline.submit(frame(9)); // attempts=1
  const farFuture = Date.now() + 30 * 24 * 60 * 60 * 1000;
  const retry = await pipeline.retryApplyOutbox(MBOX, { maxAttempts: 100, maxAgeMs: 60_000, nowMs: farFuture });
  assert.deepEqual(retry.quarantined, []);
  await pipeline.retryApplyOutbox(MBOX, { maxAttempts: 100, maxAgeMs: 60_000, nowMs: farFuture });
  assert.equal((await outbox.listPending(MBOX))[0].attempts, 2, "age parked the retained entry without waiting for a floor");
});
