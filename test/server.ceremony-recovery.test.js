import test from "node:test";
import assert from "node:assert/strict";
import { CeremonyRecoveryWorker } from "../src/server/services/CeremonyRecoveryWorker.js";
import { PendingCeremonyStore } from "../src/server/storage/PendingCeremonyStore.js";
import { PENDING_CEREMONY_STATES } from "../src/records/domain/PendingCeremonyRecordV1.js";

// AUDIT FINDING #3 — the pending-ceremony journal had no reader.
//
// PendingCeremonyStore made a device-link registration durable before device.add; nothing ever read
// it back. listResumable()/listExpirable() had no production caller, so every guarantee the journal
// was built for — republish the exact response after a crash, revoke what a dead ceremony released
// — existed only on paper.
//
// The hard part is not the sweep, it is knowing what a released leaf means. device.add is
// authoritative the MOMENT the leaf cert is released: off-home verifiers accept a valid leaf, and
// the home's terminal predicate only rejects revoked/tombstoned devices. So "the ceremony died"
// never means "nothing happened".

const DEVICE = "rez:dev:" + "1".repeat(64);
const CERT = "rez:cap:" + "a".repeat(64);
const OTHER_CERT = "rez:cap:" + "b".repeat(64);

class TestKVStore {
  constructor() { this.map = new Map(); }
  async get(k) { return this.map.has(k) ? JSON.parse(JSON.stringify(this.map.get(k))) : null; }
  async set(k, v) { this.map.set(k, JSON.parse(JSON.stringify(v))); }
  async delete(k) { this.map.delete(k); }
  async keys(prefix) {
    return [...this.map.keys()].filter((k) => typeof prefix !== "string" || k.startsWith(prefix));
  }
}

function makeStorage() {
  const kv = new TestKVStore();
  return { provider: { getKeyValueStore: () => kv }, kv };
}

function fields(overrides = {}) {
  return {
    deviceId: DEVICE,
    inboxId: "inbox:new-device",
    certId: CERT,
    leafCert: { certId: CERT, purpose: "rez:account-device-capability:v1" },
    sealedResponse: { v: 1, recordKind: "device-link-response", recordId: "resp", payloadB64: "AAA=" },
    thRequestB64: "cmVx",
    thResponseB64: "cmVz",
    confirmTagB64: "dGFn",
    expiresAtMs: 5000,
    ...overrides,
  };
}

/**
 * A scriptable home. `boundCert` is what the home has bound to DEVICE — null means device.add
 * never committed for it, which is what makes the cert-bound revoke fail with BAD_TARGET.
 */
function makeHome({ boundCert = CERT, revokedCertIds = [], revokeThrows = null, revokeSilentlyDoesNothing = false } = {}) {
  const home = {
    boundCert,
    revokedCertIds: [...revokedCertIds],
    mutations: [],
    authorityReads: 0,
    authorityState: null, // set to override the read
    async submitMutation({ action, target }) {
      home.mutations.push({ action, target });
      if (revokeThrows) throw revokeThrows;
      if (action !== "device.revoke") throw new Error("unexpected action " + action);
      if (home.boundCert === null || target.revokedCertId !== home.boundCert) {
        // Mirrors PgAccountMutationSerializer: device.revoke may only name the target device's own
        // bound cert. A never-enrolled device has no bound cert, so any certId mismatches.
        throw Object.assign(new Error("device.revoke may only revoke the target device's own bound cert"), { code: "BAD_TARGET" });
      }
      if (!revokeSilentlyDoesNothing && !home.revokedCertIds.includes(home.boundCert)) {
        home.revokedCertIds.push(home.boundCert);
      }
      return { revision: 2, devices: [] };
    },
    async getAuthorityState() {
      home.authorityReads += 1;
      if (home.authorityState !== null) return home.authorityState;
      return { epoch: 2, revokedCertIds: [...home.revokedCertIds], minValidIssuedAtMs: 0 };
    },
  };
  return home;
}

function makeRecords({ putThrows = null } = {}) {
  const puts = [];
  return {
    puts,
    async put({ record }) {
      puts.push(record);
      if (putThrows) throw putThrows;
      return { localId: "slot", replicas: 1 };
    },
  };
}

function makeWorker({ store, home, records, clock, logger }) {
  return new CeremonyRecoveryWorker({
    journal: store,
    records,
    submitMutation: (args) => home.submitMutation(args),
    getAuthorityState: () => home.getAuthorityState(),
    clock,
    logger: logger || { info() {}, warn() {}, error() {} },
  });
}

function quietLogger() {
  const logs = { info: [], warn: [], error: [] };
  return {
    logs,
    logger: {
      info: (m) => logs.info.push(m),
      warn: (m) => logs.warn.push(m),
      error: (m) => logs.error.push(m),
    },
  };
}

// ── RESTART BEFORE PUBLISH ─────────────────────────────────────────────────────────────────────

test("restart-before-publish: the EXACT stored response is republished, then marked published", async () => {
  // Recovery cannot mean "retry the ceremony" — a fresh ceremony mints a different certId (derived
  // from a body including issuedAtMs), so a retry never converges on the registration that already
  // committed. It has to replay these exact bytes.
  const { provider } = makeStorage();
  let now = 1000;
  const store = new PendingCeremonyStore({ storageProvider: provider, clock: () => now });
  const created = await store.createPending(fields());
  const records = makeRecords();
  const home = makeHome();
  const worker = makeWorker({ store, home, records, clock: () => now });

  const result = await worker.sweep({});

  assert.deepEqual(result.republished, [DEVICE]);
  assert.equal(records.puts.length, 1);
  assert.deepEqual(records.puts[0], created.sealedResponse, "the stored bytes, verbatim");
  assert.equal((await store.get(DEVICE)).state, PENDING_CEREMONY_STATES.PUBLISHED);
  assert.equal(home.mutations.length, 0, "resuming publishes; it does not mutate the account");
});

test("restart-before-publish: markPublished happens AFTER the put, never before", async () => {
  // Marking first would record a publication that never happened, and the record would then be
  // permanently skipped by the resume pass — the leaf silently never reaching the new device.
  const { provider } = makeStorage();
  let now = 1000;
  const store = new PendingCeremonyStore({ storageProvider: provider, clock: () => now });
  await store.createPending(fields());
  const records = makeRecords({ putThrows: new Error("overlay unreachable") });
  const { logger, logs } = quietLogger();
  const worker = makeWorker({ store, home: makeHome(), records, clock: () => now, logger });

  const result = await worker.sweep({});

  assert.deepEqual(result.republished, []);
  assert.equal(result.retained.length, 1);
  assert.equal((await store.get(DEVICE)).state, PENDING_CEREMONY_STATES.PENDING, "still owes a publication");
  assert.ok(logs.error.some((m) => m.includes("could not republish")));

  // And the next sweep simply retries it — idempotently, since republishing the same record to the
  // same owner-keyed slot is a no-op at the store.
  const ok = makeRecords();
  const retry = makeWorker({ store, home: makeHome(), records: ok, clock: () => now });
  assert.deepEqual((await retry.sweep({})).republished, [DEVICE]);
  assert.equal((await store.get(DEVICE)).state, PENDING_CEREMONY_STATES.PUBLISHED);
});

test("retry/idempotency: repeated sweeps before the deadline do not re-publish or re-mutate", async () => {
  const { provider } = makeStorage();
  let now = 1000;
  const store = new PendingCeremonyStore({ storageProvider: provider, clock: () => now });
  await store.createPending(fields());
  const records = makeRecords();
  const home = makeHome();
  const worker = makeWorker({ store, home, records, clock: () => now });

  await worker.sweep({});
  await worker.sweep({});
  await worker.sweep({});

  assert.equal(records.puts.length, 1, "published once; afterwards it is no longer resumable");
  assert.equal(home.mutations.length, 0);
});

// ── EXPIRY: BEFORE vs AFTER COMMIT ─────────────────────────────────────────────────────────────

test("expiry AFTER commit: the cert-bound revoke is submitted and the journal deleted", async () => {
  const { provider } = makeStorage();
  let now = 1000;
  const store = new PendingCeremonyStore({ storageProvider: provider, clock: () => now });
  await store.createPending(fields({ expiresAtMs: 5000 }));
  await store.markPublished(DEVICE); // the leaf is out
  const home = makeHome({ boundCert: CERT });
  const { logger, logs } = quietLogger();
  const worker = makeWorker({ store, home, records: makeRecords(), clock: () => now, logger });

  now = 6000; // past the deadline, never confirmed
  const result = await worker.sweep({});

  assert.deepEqual(result.revoked, [DEVICE]);
  assert.equal(home.mutations.length, 1);
  assert.equal(home.mutations[0].action, "device.revoke");
  // CERT-BOUND: the home rejects a revokedCertId that is not the device's bound cert, so this can
  // never revoke a later, legitimate re-registration of the same device.
  assert.deepEqual(home.mutations[0].target, { revokedDeviceId: DEVICE, revokedCertId: CERT });
  assert.ok(home.revokedCertIds.includes(CERT));
  assert.equal(await store.get(DEVICE), null, "journal cleared only after the revoke committed");
  assert.ok(logs.warn.some((m) => m.includes("compensated an expired device-link")));
});

test("expiry BEFORE commit: the home denies the binding, nothing was released, journal cleared", async () => {
  // device.add never committed and the response was never published, so no authority ever existed.
  // There is nothing to revoke — and the row must still become removable, or createPending's
  // no-overwrite rule would lock this device out of ever linking again.
  const { provider } = makeStorage();
  let now = 1000;
  const store = new PendingCeremonyStore({ storageProvider: provider, clock: () => now });
  await store.createPending(fields({ expiresAtMs: 5000 }));
  const home = makeHome({ boundCert: null });
  const worker = makeWorker({ store, home, records: makeRecords(), clock: () => now });

  now = 6000;
  const result = await worker.sweep({});

  assert.deepEqual(result.disproven, [DEVICE]);
  assert.equal(home.mutations.length, 1, "the revoke was attempted — commitment is disproved, not assumed");
  assert.equal(await store.get(DEVICE), null);
});

test("expiry: a PENDING record is marked expired before the revoke is attempted", async () => {
  // The durable state must match reality even if the revoke below fails.
  const { provider } = makeStorage();
  let now = 1000;
  const store = new PendingCeremonyStore({ storageProvider: provider, clock: () => now });
  await store.createPending(fields({ expiresAtMs: 5000 }));
  const home = makeHome({ boundCert: CERT, revokeThrows: new Error("home unreachable") });
  const worker = makeWorker({ store, home, records: makeRecords(), clock: () => now });

  now = 6000;
  await worker.sweep({});

  const after = await store.get(DEVICE);
  assert.ok(after !== null, "retained");
  assert.equal(after.state, PENDING_CEREMONY_STATES.EXPIRED);
});

// ── PUBLISHED WITHOUT CONFIRMATION ─────────────────────────────────────────────────────────────

test("published-without-confirmation is COVERED by the sweep, not treated as job done", async () => {
  // The most dangerous state: the response reached the rendezvous coordinate, so anything watching
  // it can hold real authority — and the ceremony then expired without the device ever confirming.
  const { provider } = makeStorage();
  let now = 1000;
  const store = new PendingCeremonyStore({ storageProvider: provider, clock: () => now });
  await store.createPending(fields({ expiresAtMs: 5000 }));
  await store.markPublished(DEVICE);
  const home = makeHome({ boundCert: CERT });
  const worker = makeWorker({ store, home, records: makeRecords(), clock: () => now });

  now = 6000;
  assert.equal((await store.listExpirable()).length, 0, "listExpirable alone would miss it");
  assert.equal((await store.listCompensatable()).length, 1, "the compensation work-list catches it");

  const result = await worker.sweep({});
  assert.deepEqual(result.revoked, [DEVICE]);
  assert.ok(home.revokedCertIds.includes(CERT));
});

test("a CONFIRMED ceremony is never compensated — the link succeeded", async () => {
  const { provider } = makeStorage();
  let now = 1000;
  const store = new PendingCeremonyStore({ storageProvider: provider, clock: () => now });
  await store.createPending(fields({ expiresAtMs: 5000 }));
  await store.markPublished(DEVICE);
  await store.markConfirmed(DEVICE);
  const home = makeHome({ boundCert: CERT });
  const worker = makeWorker({ store, home, records: makeRecords(), clock: () => now });

  now = 6000;
  const result = await worker.sweep({});

  assert.deepEqual(result.revoked, []);
  assert.equal(home.mutations.length, 0, "a linked device is not revoked for missing a deadline");
  assert.ok(await store.get(DEVICE) !== null);
});

test("PUBLISHED + home denies the binding = contradictory: RETAIN and fail loud", async () => {
  // A leaf is out, and the home says it never bound that cert — so nothing can revoke it. This is
  // the case that must never be quietly dropped.
  const { provider } = makeStorage();
  let now = 1000;
  const store = new PendingCeremonyStore({ storageProvider: provider, clock: () => now });
  await store.createPending(fields({ expiresAtMs: 5000 }));
  await store.markPublished(DEVICE);
  const home = makeHome({ boundCert: null });
  const { logger, logs } = quietLogger();
  const worker = makeWorker({ store, home, records: makeRecords(), clock: () => now, logger });

  now = 6000;
  const result = await worker.sweep({});

  assert.deepEqual(result.revoked, []);
  assert.deepEqual(result.disproven, []);
  assert.equal(result.retained.length, 1);
  assert.ok(await store.get(DEVICE) !== null, "the journal is KEPT");
  assert.ok(logs.error.some((m) => m.includes("may still be live off-home")));
});

test("a revoke that reports success without revoking the cert RETAINS and fails loud", async () => {
  // Proof, not optimism: the certId appearing in the revoked set is what the home writes in the
  // same transaction that bumps the epoch and enqueues propagation. Without it, nothing was
  // achieved — and deleting the journal here would destroy the only certId able to try again.
  const { provider } = makeStorage();
  let now = 1000;
  const store = new PendingCeremonyStore({ storageProvider: provider, clock: () => now });
  await store.createPending(fields({ expiresAtMs: 5000 }));
  await store.markPublished(DEVICE);
  const home = makeHome({ boundCert: CERT, revokeSilentlyDoesNothing: true });
  const { logger, logs } = quietLogger();
  const worker = makeWorker({ store, home, records: makeRecords(), clock: () => now, logger });

  now = 6000;
  const result = await worker.sweep({});

  assert.equal(result.retained.length, 1);
  assert.ok(await store.get(DEVICE) !== null);
  assert.ok(logs.error.some((m) => m.includes("may still be live off-home")));
});

test("an already-revoked cert finishes the job idempotently", async () => {
  // A previous sweep committed the revoke and died before deleting.
  const { provider } = makeStorage();
  let now = 1000;
  const store = new PendingCeremonyStore({ storageProvider: provider, clock: () => now });
  await store.createPending(fields({ expiresAtMs: 5000 }));
  await store.markPublished(DEVICE);
  const home = makeHome({ boundCert: CERT, revokedCertIds: [CERT] });
  const worker = makeWorker({ store, home, records: makeRecords(), clock: () => now });

  now = 6000;
  const result = await worker.sweep({});

  assert.deepEqual(result.revoked, [DEVICE]);
  assert.equal(home.mutations.length, 0, "no second revoke was submitted");
  assert.equal(await store.get(DEVICE), null);
});

test("compensation is idempotent across repeated sweeps", async () => {
  const { provider } = makeStorage();
  let now = 1000;
  const store = new PendingCeremonyStore({ storageProvider: provider, clock: () => now });
  await store.createPending(fields({ expiresAtMs: 5000 }));
  await store.markPublished(DEVICE);
  const home = makeHome({ boundCert: CERT });
  const worker = makeWorker({ store, home, records: makeRecords(), clock: () => now });

  now = 6000;
  await worker.sweep({});
  await worker.sweep({});
  await worker.sweep({});

  assert.equal(home.mutations.length, 1, "revoked exactly once; the row is gone after the first");
});

// ── AUTHORITY-READ FAILURES ────────────────────────────────────────────────────────────────────

test("an unreadable authority state RETAINS — it is never read as 'not revoked'", async () => {
  const { provider } = makeStorage();
  let now = 1000;
  const store = new PendingCeremonyStore({ storageProvider: provider, clock: () => now });
  await store.createPending(fields({ expiresAtMs: 5000 }));
  await store.markPublished(DEVICE);
  const home = makeHome({ boundCert: CERT });
  home.authorityState = { epoch: 2 }; // no revokedCertIds array — drift, not an answer
  const worker = makeWorker({ store, home, records: makeRecords(), clock: () => now });

  now = 6000;
  const result = await worker.sweep({});

  assert.equal(result.retained.length, 1);
  assert.equal(home.mutations.length, 0, "nothing was submitted on an unreadable state");
  assert.ok(await store.get(DEVICE) !== null);
});

// ── CORRUPTION ─────────────────────────────────────────────────────────────────────────────────

test("a corrupt journal row surfaces as a sweep failure, not as an empty work-list", async () => {
  // Absence and corruption must not look alike: reading a damaged row as "nothing to recover"
  // would silently abandon a registration whose leaf may be live.
  const { provider, kv } = makeStorage();
  let now = 1000;
  const store = new PendingCeremonyStore({ storageProvider: provider, clock: () => now });
  await store.createPending(fields());
  await kv.set("app:pendingceremony/" + DEVICE, { deviceId: DEVICE, state: "pending" }); // truncated
  const worker = makeWorker({ store, home: makeHome(), records: makeRecords(), clock: () => now });

  await assert.rejects(() => worker.sweep({}), /PendingCeremonyRecordV1/);
});

// ── ONE BAD RECORD MUST NOT STOP THE OTHERS ────────────────────────────────────────────────────

test("one unrecoverable registration does not block recovery of the rest", async () => {
  const other = "rez:dev:" + "2".repeat(64);
  const { provider } = makeStorage();
  let now = 1000;
  const store = new PendingCeremonyStore({ storageProvider: provider, clock: () => now });
  await store.createPending(fields({ expiresAtMs: 5000 }));
  await store.markPublished(DEVICE);
  await store.createPending(fields({ deviceId: other, certId: OTHER_CERT, expiresAtMs: 9000 }));

  // DEVICE is expired and its home read will fail; `other` is still in time and must republish.
  const home = makeHome({ boundCert: CERT, revokeThrows: new Error("home unreachable") });
  const records = makeRecords();
  const worker = makeWorker({ store, home, records, clock: () => now });

  now = 6000;
  const result = await worker.sweep({});

  assert.deepEqual(result.republished, [other], "the healthy one still recovered");
  assert.equal(result.retained.length, 1);
  assert.equal(result.retained[0].deviceId, DEVICE);
});

// ── SERIALIZATION ──────────────────────────────────────────────────────────────────────────────

test("a device owned by an ACTIVE ceremony is skipped, not swept", async () => {
  const { provider } = makeStorage();
  let now = 1000;
  const store = new PendingCeremonyStore({ storageProvider: provider, clock: () => now });
  await store.createPending(fields());
  const records = makeRecords();
  const home = makeHome();
  const worker = makeWorker({ store, home, records, clock: () => now });

  const result = await worker.sweep({ skipDeviceIds: [DEVICE] });

  assert.deepEqual(result.skipped, [DEVICE]);
  assert.equal(records.puts.length, 0, "the live ceremony owns this publication");
  assert.equal((await store.get(DEVICE)).state, PENDING_CEREMONY_STATES.PENDING);
});

// ── THE STORE'S OWN RULES ──────────────────────────────────────────────────────────────────────

test("createPending REFUSES to overwrite an expired row", async () => {
  // This used to be allowed, and it was the inverse of the truth: an expired registration is the
  // one most likely to be holding a released leaf that was never compensated, and overwriting it
  // destroyed the only copy of the certId a compensating revoke needs.
  const { provider } = makeStorage();
  let now = 1000;
  const store = new PendingCeremonyStore({ storageProvider: provider, clock: () => now });
  await store.createPending(fields({ expiresAtMs: 2000 }));
  await store.markExpired(DEVICE);

  await assert.rejects(
    () => store.createPending(fields({ certId: OTHER_CERT })),
    /already has a registration in state expired/,
  );

  // Only after the compensating revoke removes it can the device register again.
  now = 6000;
  const home = makeHome({ boundCert: CERT });
  await makeWorker({ store, home, records: makeRecords(), clock: () => now }).sweep({});
  assert.equal(await store.get(DEVICE), null);
  const fresh = await store.createPending(fields({ certId: OTHER_CERT }));
  assert.equal(fresh.state, PENDING_CEREMONY_STATES.PENDING);
});

test("deleteAfterDisprovenCommit demands BOTH proofs and refuses a published row", async () => {
  const { provider } = makeStorage();
  const now = 1000;
  const store = new PendingCeremonyStore({ storageProvider: provider, clock: () => now });
  await store.createPending(fields());

  await assert.rejects(
    () => store.deleteAfterDisprovenCommit(DEVICE, { neverPublished: true, certId: CERT }),
    /without the home explicitly denying/,
  );
  await assert.rejects(
    () => store.deleteAfterDisprovenCommit(DEVICE, { homeRejectedCertBinding: true, certId: CERT }),
    /whose sealed response was published/,
  );
  await assert.rejects(
    () => store.deleteAfterDisprovenCommit(DEVICE, { homeRejectedCertBinding: true, neverPublished: true, certId: OTHER_CERT }),
    /does not name this registration's certId/,
  );

  await store.markPublished(DEVICE);
  await assert.rejects(
    () => store.deleteAfterDisprovenCommit(DEVICE, { homeRejectedCertBinding: true, neverPublished: true, certId: CERT }),
    /its response WAS published/,
  );
});

test("a DECLINED mutation is reported as a decline, not as a mystery non-revoke", async () => {
  // The account-mutation service answers null when it is not enabled on this runtime. Letting that
  // fall through would surface as "the revoke succeeded but the cert is not revoked", which reads
  // like home corruption rather than a runtime that simply cannot mutate.
  const { provider } = makeStorage();
  let now = 1000;
  const store = new PendingCeremonyStore({ storageProvider: provider, clock: () => now });
  await store.createPending(fields({ expiresAtMs: 5000 }));
  await store.markPublished(DEVICE);
  const { logger, logs } = quietLogger();
  const worker = new CeremonyRecoveryWorker({
    journal: store,
    records: makeRecords(),
    submitMutation: async () => null,
    getAuthorityState: async () => ({ epoch: 1, revokedCertIds: [], minValidIssuedAtMs: 0 }),
    clock: () => now,
    logger,
  });

  now = 6000;
  const result = await worker.sweep({});

  assert.equal(result.retained.length, 1);
  assert.match(result.retained[0].reason, /declined the compensating revoke/);
  assert.ok(await store.get(DEVICE) !== null, "journal retained");
  assert.ok(logs.error.some((m) => m.includes("may still be live off-home")));
});
