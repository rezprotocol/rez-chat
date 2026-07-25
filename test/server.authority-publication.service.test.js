import test from "node:test";
import assert from "node:assert/strict";
import { ServerAuthorityPublicationService } from "../src/server/services/ServerAuthorityPublicationService.js";

const TOKEN = "a".repeat(48);
const NOW = 1_700_000_000_000;

// A scriptable stand-in for the node's outbox surface. Every call is recorded so the tests can
// assert the LEASE PROTOCOL (claim → prepare → complete, with release/fail on the off-paths),
// not just the return value.
function makeOutbox({ claims = [], prepares = [], completes = [], failOn = null } = {}) {
  const calls = [];
  const next = (queue, fallback) => (queue.length > 1 ? queue.shift() : (queue[0] !== undefined ? queue[0] : fallback));
  return {
    calls,
    async claim() {
      calls.push({ op: "claim" });
      if (failOn === "claim") throw Object.assign(new Error("no outbox here"), { code: "SERVICE_UNAVAILABLE" });
      return next(claims, { leased: false });
    },
    async prepare({ leaseToken }) {
      calls.push({ op: "prepare", leaseToken });
      return next(prepares, { prepared: false });
    },
    async release({ leaseToken }) {
      calls.push({ op: "release", leaseToken });
      return { released: true };
    },
    async fail({ leaseToken }) {
      calls.push({ op: "fail", leaseToken });
      if (failOn === "fail") throw new Error("fail() itself is down");
      return { recorded: true, attemptedEpoch: 6, anchorEpoch: 6, attempts: 1, backoffMs: 1000, blocked: false };
    },
    async complete({ leaseToken, record }) {
      calls.push({ op: "complete", leaseToken, record });
      if (failOn === "complete") throw new Error("complete exploded");
      return next(completes, { completed: false });
    },
  };
}

function makeHarness({
  outbox = makeOutbox(),
  authorityStates = [{ epoch: 6, revokedCertIds: ["rez:cap:" + "a".repeat(64)], minValidIssuedAtMs: 0 }],
  withOutbox = true,
  buildThrows = false,
} = {}) {
  const built = [];
  const logs = { warn: [], error: [], info: [] };
  const states = [...authorityStates];
  const sdk = {
    accountOutbox: withOutbox ? outbox : null,
    devices: {
      async getAuthorityState() {
        return states.length > 1 ? states.shift() : states[0];
      },
    },
  };
  const peerLinks = {
    async buildAccountAuthorityStateRecord(args) {
      built.push(args);
      if (buildThrows) throw new Error("signing key unavailable");
      return { record: { recordKind: "rez.account.authority-state.v1", epoch: args.epoch } };
    },
  };
  const bus = {
    runtime: { sdk, peerLinks },
    on() { return () => {}; },
    emit() {},
    registerFunction() {},
    call() { return Promise.resolve(null); },
  };
  const svc = new ServerAuthorityPublicationService({
    bus,
    ownerAccountId: "rez:acct:alice",
    clock: () => NOW,
    logger: {
      warn: (m) => logs.warn.push(m),
      error: (m) => logs.error.push(m),
      info: (m) => logs.info.push(m),
      log: () => {},
    },
  });
  return { svc, outbox, built, logs };
}

const LEASED = { leased: true, token: TOKEN, anchorEpoch: 6, headEpoch: 6, leaseExpiresAtMs: NOW + 30_000, attempts: 0 };
const PREPARED = { prepared: true, anchorEpoch: 6, headEpoch: 6 };

test("the happy path: claim → prepare → publish the FROZEN epoch → complete", async () => {
  const outbox = makeOutbox({
    claims: [LEASED, { leased: false }],
    prepares: [PREPARED],
    completes: [{ completed: true, doneThroughEpoch: 6 }],
  });
  const { svc, built } = makeHarness({ outbox });

  const res = await svc.drainPublications();

  assert.deepEqual(res.publishedEpochs, [6]);
  assert.equal(res.stopped, "nothing-pending", "drains until the queue is empty");
  assert.deepEqual(outbox.calls.map((c) => c.op), ["claim", "prepare", "complete", "claim"]);

  // The record is built for the epoch the LEASE froze, from the home's authority state.
  assert.equal(built.length, 1);
  assert.equal(built[0].epoch, 6);
  assert.deepEqual(built[0].revokedCertIds, ["rez:cap:" + "a".repeat(64)]);
  assert.equal(built[0].nowMs, NOW);

  const complete = outbox.calls.find((c) => c.op === "complete");
  assert.equal(complete.leaseToken, TOKEN);
  assert.equal(complete.record.epoch, 6, "the submitted record is the one just built");
});

test("head advanced under the lease: RELEASE and re-claim, never publish a different epoch", async () => {
  // The node froze epoch 6, but the home is already at 7 by the time we read it. Publishing 7
  // would be rejected (M must equal prepared_epoch) and publishing 6 would be a lie.
  const outbox = makeOutbox({
    claims: [LEASED, { leased: true, token: TOKEN, anchorEpoch: 7, headEpoch: 7, leaseExpiresAtMs: NOW, attempts: 0 }, { leased: false }],
    prepares: [PREPARED, { prepared: true, anchorEpoch: 7, headEpoch: 7 }],
    completes: [{ completed: true, doneThroughEpoch: 7 }],
  });
  const { svc, built } = makeHarness({
    outbox,
    authorityStates: [
      { epoch: 7, revokedCertIds: [], minValidIssuedAtMs: 0 },
      { epoch: 7, revokedCertIds: [], minValidIssuedAtMs: 0 },
    ],
  });

  const res = await svc.drainPublications();

  assert.deepEqual(outbox.calls.map((c) => c.op), ["claim", "prepare", "release", "claim", "prepare", "complete", "claim"]);
  assert.deepEqual(res.publishedEpochs, [7], "converges on the new head");
  assert.equal(built.length, 1, "nothing was built for the stale frozen epoch");
  assert.equal(built[0].epoch, 7);
  // Released, NOT failed: losing a race is not a failed attempt and must not accrue backoff.
  assert.equal(outbox.calls.some((c) => c.op === "fail"), false);
});

test("a fault under lease reports the attempt via fail() and RETHROWS the original error", async () => {
  const outbox = makeOutbox({ claims: [LEASED], prepares: [PREPARED], failOn: "complete" });
  const { svc, logs } = makeHarness({ outbox });

  await assert.rejects(() => svc.drainPublications(), /complete exploded/, "the real fault surfaces");
  assert.deepEqual(outbox.calls.map((c) => c.op), ["claim", "prepare", "complete", "fail"]);
  assert.ok(logs.warn.some((m) => m.includes("publication attempt failed")));
});

test("a build failure is reported too — the obligation must never look discharged", async () => {
  const outbox = makeOutbox({ claims: [LEASED], prepares: [PREPARED] });
  const { svc } = makeHarness({ outbox, buildThrows: true });

  await assert.rejects(() => svc.drainPublications(), /signing key unavailable/);
  assert.equal(outbox.calls.at(-1).op, "fail");
  assert.equal(outbox.calls.some((c) => c.op === "complete"), false, "nothing was submitted");
});

test("a BLOCKED lease is escalated to the operator log", async () => {
  const outbox = makeOutbox({ claims: [LEASED], prepares: [PREPARED], failOn: "complete" });
  outbox.fail = async ({ leaseToken }) => {
    outbox.calls.push({ op: "fail", leaseToken });
    return { recorded: true, attemptedEpoch: 6, anchorEpoch: 6, attempts: 9, backoffMs: 60_000, blocked: true };
  };
  const { svc, logs } = makeHarness({ outbox });

  await assert.rejects(() => svc.drainPublications(), /complete exploded/);
  assert.ok(
    logs.error.some((m) => m.includes("BLOCKED") && m.includes("NOT reaching off-home peers")),
    "a blocked publication is an operator-visible security condition, not a debug line",
  );
});

test("a failure to REPORT the failure never masks the original error", async () => {
  const brokenFail = makeOutbox({ claims: [LEASED], prepares: [PREPARED], failOn: "complete" });
  brokenFail.fail = async () => { throw new Error("fail() itself is down"); };
  const { svc, logs } = makeHarness({ outbox: brokenFail });

  await assert.rejects(() => svc.drainPublications(), /complete exploded/, "the ORIGINAL fault, not the reporting fault");
  assert.ok(logs.error.some((m) => m.includes("could not record the failed attempt")));
});

test("an authority epoch BEHIND the frozen epoch is an invariant violation, not a race", async () => {
  // The obligation is enqueued in the same transaction that bumps the epoch, so the home can
  // never owe a publication for an epoch it has not reached.
  const outbox = makeOutbox({ claims: [LEASED], prepares: [PREPARED] });
  const { svc } = makeHarness({ outbox, authorityStates: [{ epoch: 5, revokedCertIds: [], minValidIssuedAtMs: 0 }] });

  await assert.rejects(() => svc.drainPublications(), /is BEHIND the prepared publication epoch 6/);
  assert.equal(outbox.calls.at(-1).op, "fail", "still reported, so the lease is not left dangling");
});

test("lease-lost at prepare or at complete is benign — no throw, nothing published", async () => {
  const lostAtPrepare = makeOutbox({ claims: [LEASED], prepares: [{ prepared: false }] });
  const a = makeHarness({ outbox: lostAtPrepare });
  const resA = await a.svc.drainPublications();
  assert.equal(resA.stopped, "lease-lost");
  assert.deepEqual(resA.publishedEpochs, []);
  assert.equal(lostAtPrepare.calls.some((c) => c.op === "fail"), false, "losing a lease is not a failed attempt");

  const lostAtComplete = makeOutbox({ claims: [LEASED], prepares: [PREPARED], completes: [{ completed: false }] });
  const b = makeHarness({ outbox: lostAtComplete });
  const resB = await b.svc.drainPublications();
  assert.equal(resB.stopped, "lease-lost");
  assert.deepEqual(resB.publishedEpochs, []);
});

test("nothing to publish is a normal outcome, not an error", async () => {
  const outbox = makeOutbox({ claims: [{ leased: false }] });
  const { svc } = makeHarness({ outbox });
  const res = await svc.drainPublications();
  assert.deepEqual(res, { enabled: true, cycles: 1, publishedEpochs: [], stopped: "nothing-pending" });
});

test("a node without a propagation outbox is reported and skipped, not retried or thrown", async () => {
  const outbox = makeOutbox({ failOn: "claim" });
  const { svc, logs } = makeHarness({ outbox });
  const res = await svc.drainPublications();
  assert.equal(res.stopped, "outbox-unavailable");
  assert.ok(logs.info.some((m) => m.includes("no propagation outbox")));
  assert.equal(outbox.calls.length, 1, "no retry storm against a node that will never have one");
});

test("a non-SERVICE_UNAVAILABLE claim failure propagates", async () => {
  const outbox = makeOutbox();
  outbox.claim = async () => { throw Object.assign(new Error("nope"), { code: "FORBIDDEN" }); };
  const { svc } = makeHarness({ outbox });
  await assert.rejects(() => svc.drainPublications(), /nope/, "an authz failure must not look like a missing outbox");
});

test("the cycle budget bounds a continuously-mutating account", async () => {
  // Every cycle loses the race, so the drain must return rather than spin forever.
  const outbox = makeOutbox({ claims: [LEASED], prepares: [PREPARED] });
  const { svc } = makeHarness({ outbox, authorityStates: [{ epoch: 99, revokedCertIds: [], minValidIssuedAtMs: 0 }] });

  const res = await svc.drainPublications({ maxCycles: 3 });
  assert.equal(res.stopped, "max-cycles");
  assert.equal(res.cycles, 3);
  assert.deepEqual(res.publishedEpochs, []);
  assert.equal(outbox.calls.filter((c) => c.op === "release").length, 3);
});

test("a runtime without the outbox surface drains nothing and reports it", async () => {
  const { svc } = makeHarness({ withOutbox: false });
  assert.equal(svc.isEnabled(), false);
  assert.deepEqual(await svc.drainPublications(), { enabled: false, cycles: 0, publishedEpochs: [], stopped: "disabled" });
});
