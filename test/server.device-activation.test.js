import test from "node:test";
import assert from "node:assert/strict";
import { DeviceActivationJournal, ACTIVATION_STATES } from "../src/server/device/DeviceActivationJournal.js";
import { ServerDeviceActivationService } from "../src/server/services/ServerDeviceActivationService.js";
import { ServerAccountStateSyncService } from "../src/server/services/ServerAccountStateSyncService.js";

// Device activation (plans/DEVICE_ACTIVATION_PLAN.md): the transaction
// NEW → BOOTSTRAPPING → READY → ACTIVE with ONE externally visible commit —
// bundle publication — sequenced behind bootstrap completeness. Frozen rules
// pinned here: the stall window is a LIVENESS trigger, never a completeness
// substitute; the marker binds to the activation transaction; the network's
// observable truth wins over the journal.

function makeKv() {
  const m = new Map();
  return {
    async get(k) { return m.has(k) ? JSON.parse(m.get(k)) : null; },
    async set(k, v) { m.set(k, JSON.stringify(v)); },
    async delete(k) { return m.delete(k); },
    async keys(prefix) { const o = []; for (const k of m.keys()) if (!prefix || k.startsWith(prefix)) o.push(k); return o; },
    _raw: m,
  };
}
const storageOf = (kv) => ({ getKeyValueStore: () => kv });

// ---- Journal: transaction-resume facts only ----

test("journal: transitions, idempotence, persistence, and the two-enrollments fail-loud", async () => {
  const kv = makeKv();
  const j = new DeviceActivationJournal({ storageProvider: storageOf(kv) });
  await j.hydrate();
  assert.equal(j.get(), null, "no journal = pre-plan device");

  await j.ensureBootstrapping({ activationId: "cert-1", nowMs: 100 });
  assert.equal(j.get().state, ACTIVATION_STATES.BOOTSTRAPPING);
  await j.ensureBootstrapping({ activationId: "cert-1", nowMs: 200 });
  assert.equal(j.get().startedAtMs, 100, "idempotent resume keeps the original start");
  await assert.rejects(() => j.ensureBootstrapping({ activationId: "cert-OTHER" }), /two enrollments/);

  await j.markReady({ baselineOrigin: "rez:dev:approver", horizonLamport: 7 });
  assert.equal(j.get().state, ACTIVATION_STATES.READY);
  await j.markActive();
  await j.markActive(); // idempotent
  assert.equal(j.get().state, ACTIVATION_STATES.ACTIVE);

  // Crash-resume: a fresh instance over the same storage sees the same facts.
  const reborn = new DeviceActivationJournal({ storageProvider: storageOf(kv) });
  await reborn.hydrate();
  assert.equal(reborn.get().state, ACTIVATION_STATES.ACTIVE);
  assert.equal(reborn.get().horizonLamport, 7);
});

// ---- Activation service ----

function makeActivationHarness({ kv = makeKv(), selfInSet = false, certChain = [{ certId: "cert-1", granteeDeviceId: "rez:dev:self" }], clockMs = 1_000 } = {}) {
  const calls = { publishOwnBundle: 0, republish: 0, requestBaseline: [] };
  const clock = { now: clockMs };
  const bus = {
    config: { identity: { certChain } },
    runtime: {
      peerLinks: { deviceId: "rez:dev:self" },
      sdk: {
        devices: {
          getAccountDeviceSet: async () => ({
            devices: selfInSet ? [{ deviceId: "rez:dev:self" }, { deviceId: "rez:dev:approver" }] : [{ deviceId: "rez:dev:approver" }],
          }),
        },
      },
    },
    services: {},
    functions: {},
    on() { return () => {}; },
    emit() {},
    registerFunction(ns, name, fn) {
      if (!this.functions[ns]) this.functions[ns] = {};
      this.functions[ns][name] = fn;
    },
    async call(ns, name, payload) {
      if (ns === "device-set" && name === "publishOwnBundle") { calls.publishOwnBundle += 1; return {}; }
      if (ns === "device-set" && name === "republishToAllPeers") { calls.republish += 1; return {}; }
      if (ns === "account-state" && name === "requestActivationBaseline") { calls.requestBaseline.push(payload); return { sent: true }; }
      const fn = this.functions[ns] && this.functions[ns][name];
      if (typeof fn === "function") return fn(payload);
      throw new Error("missing " + ns + "." + name);
    },
  };
  const svc = new ServerDeviceActivationService({
    bus,
    ownerAccountId: "rez:acct:alice",
    storageProvider: storageOf(kv),
    clock: () => clock.now,
    logger: { log() {}, warn() {}, error() {} },
  });
  return { svc, bus, calls, kv, clock };
}

test("sync: a fresh post-plan enrollment starts BOOTSTRAPPING, publication is DEFERRED, and the baseline is REQUESTED immediately (P1.3-pre: the approver's confirm-time push cannot land before this device's first claim)", async () => {
  const { svc, calls } = makeActivationHarness({ selfInSet: false });
  const gate = await svc.syncWithNetwork();
  assert.equal(gate.publish, false, "not visible until the commit");
  assert.equal(gate.state, "BOOTSTRAPPING");
  assert.equal((await svc.status()).activationId, "cert-1", "activationId bound from the device's own leaf cert");
  assert.equal(calls.publishOwnBundle, 0);
  assert.deepEqual(calls.requestBaseline, [{ activationId: "cert-1" }],
    "the first bootstrapping sync requests the baseline — the deterministic delivery path");
});

test("sync: the network's truth WINS — self already in the served set converges to ACTIVE (crash after publication / pre-plan device)", async () => {
  const kv = makeKv();
  // Journal says READY (crashed between marker and cleanup)…
  const j = new DeviceActivationJournal({ storageProvider: storageOf(kv) });
  await j.hydrate();
  await j.ensureBootstrapping({ activationId: "cert-1", nowMs: 1 });
  await j.markReady({ baselineOrigin: "o", horizonLamport: 3 });
  // …but the network already serves the bundle.
  const { svc, calls } = makeActivationHarness({ kv, selfInSet: true });
  const gate = await svc.syncWithNetwork();
  assert.equal(gate.state, "ACTIVE", "converged by OBSERVATION, never re-decided");
  assert.equal(gate.publish, true, "reconnect republish is the shipped idempotent behavior");
  assert.equal(calls.publishOwnBundle, 0, "no separate commit path ran");
  assert.equal((await svc.status()).state, "ACTIVE");
});

test("sync: READY-but-not-committed (crash between marker and publication) commits EXACTLY ONCE on resume", async () => {
  const kv = makeKv();
  const j = new DeviceActivationJournal({ storageProvider: storageOf(kv) });
  await j.hydrate();
  await j.ensureBootstrapping({ activationId: "cert-1", nowMs: 1 });
  await j.markReady({ baselineOrigin: "o", horizonLamport: 3 });

  const { svc, calls } = makeActivationHarness({ kv, selfInSet: false });
  const gate = await svc.syncWithNetwork();
  assert.equal(gate.state, "ACTIVE");
  assert.equal(calls.publishOwnBundle, 1, "the commit ran");
  assert.equal(calls.republish, 1);
  // A second sync after the commit does not re-run it via the READY path.
  await svc.syncWithNetwork();
  assert.equal(calls.publishOwnBundle, 1, "committed exactly once through the READY path");
});

test("marker: a matching baselineComplete with the horizon satisfied flips READY and commits; mismatched or premature markers park (frozen: never READY without completeness)", async () => {
  const { svc, calls } = makeActivationHarness({ selfInSet: false });
  await svc.syncWithNetwork(); // BOOTSTRAPPING

  // Wrong activation transaction: completes nothing.
  let r = await svc.onBaselineComplete({ activationId: "cert-OTHER", originDeviceId: "o", horizonLamport: 3, seenBeforeLamport: 3 });
  assert.equal(r.reason, "activation-mismatch");
  assert.equal((await svc.status()).state, "BOOTSTRAPPING");

  // Premature: baseline events not all folded (seenBefore < horizon).
  r = await svc.onBaselineComplete({ activationId: "cert-1", originDeviceId: "o", horizonLamport: 5, seenBeforeLamport: 3 });
  assert.equal(r.reason, "premature-marker");
  assert.equal((await svc.status()).state, "BOOTSTRAPPING", "the frozen rule: stay put, let recovery re-request");
  assert.equal(calls.publishOwnBundle, 0);

  // Valid: horizon satisfied → READY → commit → ACTIVE.
  r = await svc.onBaselineComplete({ activationId: "cert-1", originDeviceId: "o", horizonLamport: 5, seenBeforeLamport: 5 });
  assert.equal(r.applied, true);
  assert.equal((await svc.status()).state, "ACTIVE");
  assert.equal(calls.publishOwnBundle, 1);
  assert.equal(calls.republish, 1);
});

test("liveness: EVERY bootstrapping sync re-requests the baseline — and nothing else (a request can never produce READY/ACTIVE; only a valid, complete marker does)", async () => {
  const { svc, calls, clock } = makeActivationHarness({ selfInSet: false });
  await svc.syncWithNetwork();
  assert.deepEqual(calls.requestBaseline, [{ activationId: "cert-1" }]);

  clock.now = 2_000; // a later reconnect
  const gate = await svc.syncWithNetwork();
  assert.equal(gate.state, "BOOTSTRAPPING", "requests NEVER produce READY/ACTIVE");
  assert.equal(gate.publish, false);
  assert.deepEqual(calls.requestBaseline, [{ activationId: "cert-1" }, { activationId: "cert-1" }],
    "each sync re-asks (the answering sibling throttles per activationId)");
  assert.equal(calls.publishOwnBundle, 0);
});

// ---- Sync-service integration: baseline send, marker routing, request answering ----

// The mocked sibling list deliberately does NOT contain the bootstrapping
// device ("rez:dev:new"). That is production truth, not test convenience: a
// BOOTSTRAPPING device defers bundle publication until its READY→ACTIVE
// commit, so every DeviceSet-derived list structurally excludes it. The old
// harness put the new device IN this list, which hid the shipped
// baseline-undeliverable defect (P1.3-pre / frozen R1) — the baseline must be
// addressed DIRECTLY from ceremony knowledge, and these tests pin that.
function makeSyncHarness({ kv = makeKv(), ownAuthorityState = null, inboxClaimant = undefined } = {}) {
  const calls = { dispatch: [], activation: [] };
  const sdk = {
    listSiblingDeviceInboxes: async () => [{ deviceId: "rez:dev:other-sib", inboxId: "inbox:other-sib" }],
    buildAccountStateDeposit: async ({ deliverInboxId, plaintextBodyBytes }) => ({
      object: { payloadBytes: plaintextBodyBytes },
      address: { inboxId: deliverInboxId },
    }),
    mesh: { dispatch: async (object, address) => { calls.dispatch.push({ event: JSON.parse(new TextDecoder().decode(object.payloadBytes)), address }); } },
  };
  const peerLinks = {
    deviceId: "rez:dev:approver",
    devicePublicKeyB64: "approverPub",
    peerLinkStorage: { peerLinks: { getByPair: async () => null } },
    signAccountStateEvent: async () => ({ sigB64: "sig" }),
    verifyAccountStateEventSig: async () => true,
  };
  const bus = {
    runtime: {
      sdk, peerLinks, multiDeviceFanout: true,
      inboxClaimant: inboxClaimant === undefined ? { inboxId: "inbox:own" } : inboxClaimant,
    },
    services: { contacts: { listContacts: async () => ({ items: [
      { accountId: "rez:acct:carol", relationshipState: "active", displayName: "Carol" },
    ] }) }, threads: {} },
    functions: {
      "device-activation": { baselineComplete: async (p) => { calls.activation.push(p); return { applied: true }; } },
      "account-mutation": { ownAuthorityState: async () => (
        ownAuthorityState ? ownAuthorityState() : { established: true, revocationState: null, epoch: 0 }
      ) },
    },
    on() { return () => {}; }, emit() {}, registerFunction() {},
    async call(ns, name, payload) {
      const fn = this.functions[ns] && this.functions[ns][name];
      if (typeof fn === "function") return fn(payload);
      throw new Error("missing " + ns + "." + name);
    },
  };
  const svc = new ServerAccountStateSyncService({
    bus, storageProvider: storageOf(kv), ownerAccountId: "rez:acct:alice",
    clock: () => 1000, logger: { log() {}, warn() {}, error() {} },
  });
  return { svc, calls, kv };
}

test("sendActivationBaseline: DIRECT-targeted unthrottled full reconcile + a marker whose horizon is the last baseline lamport — every deposit at the ceremony inbox, none via the DeviceSet list", async () => {
  const { svc, calls } = makeSyncHarness();
  const target = { deviceId: "rez:dev:new", inboxId: "inbox:new" };
  const r1 = await svc.sendActivationBaseline({ activationId: "cert-1", target });
  assert.equal(r1.sent, true);
  assert.equal(r1.reconciled, 1);

  // FROZEN R1: the baseline never discovers its destination through
  // DeviceSet. The mocked sibling list holds ONLY inbox:other-sib; every
  // deposit must land at the targeted ceremony inbox instead.
  for (const d of calls.dispatch) {
    assert.equal(d.address.inboxId, "inbox:new", "baseline deposit addressed directly to the ceremony inbox");
  }
  assert.equal(calls.dispatch.filter((d) => d.address.inboxId === "inbox:other-sib").length, 0,
    "nothing rode the DeviceSet-derived sibling list");

  const events = calls.dispatch.map((d) => d.event);
  assert.equal(events.length, 2, "one baseline event + the marker");
  assert.equal(events[0].op, "contact.upsert");
  assert.equal(events[1].op, "activation.baselineComplete");
  assert.equal(events[1].payload.activationId, "cert-1");
  assert.equal(events[1].payload.horizonLamport, events[0].lamport, "horizon = last baseline event's lamport");
  assert.ok(events[1].lamport > events[1].payload.horizonLamport, "the marker rides ABOVE its horizon");

  // Unthrottled: an immediate resend works (the throttled reconcile would refuse).
  const r2 = await svc.sendActivationBaseline({ activationId: "cert-1", target });
  assert.equal(r2.sent, true);
  assert.equal(r2.reconciled, 1, "resend is a full re-reconcile — idempotent at the sibling");
});

test("sendActivationBaseline REFUSES loudly without a target inbox — never downgraded to the DeviceSet fan-out (zero recipients is not success)", async () => {
  const { svc, calls } = makeSyncHarness();
  const r = await svc.sendActivationBaseline({ activationId: "cert-1" });
  assert.equal(r.sent, false);
  assert.equal(r.reason, "no-target-inbox");
  assert.equal(calls.dispatch.length, 0, "nothing was fanned to the sibling list as a fallback");
});

test("requestActivationBaseline carries the requester's OWN inbox so the answer can be targeted back; refused loudly when unavailable", async () => {
  const { svc, calls } = makeSyncHarness();
  const r = await svc.requestActivationBaseline({ activationId: "cert-1" });
  assert.equal(r.sent, true);
  const requests = calls.dispatch.map((d) => d.event).filter((e) => e.op === "activation.baselineRequest");
  assert.equal(requests.length, 1, "the request rides the sibling fan-out (established siblings have bundles)");
  assert.equal(requests[0].payload.requestInboxId, "inbox:own", "the payload names the requester's claimed inbox");

  const { svc: noInboxSvc, calls: noInboxCalls } = makeSyncHarness({ inboxClaimant: null });
  const refused = await noInboxSvc.requestActivationBaseline({ activationId: "cert-1" });
  assert.equal(refused.sent, false);
  assert.equal(refused.reason, "own-inbox-unavailable");
  assert.equal(noInboxCalls.dispatch.length, 0, "an unanswerable request is not sent");
});

test("applyInbound routes a verified marker to the activation service WITH the pre-marker seen horizon", async () => {
  const { svc, calls } = makeSyncHarness();
  // Two baseline events then the marker, arriving in order from the approver.
  const mk = (op, lamport, payload) => ({
    op, lamport, originDeviceId: "rez:dev:origin", originDevicePublicKeyB64: "originPub",
    payload, issuedAtMs: 1, sig: "s",
  });
  await svc.applyInbound(mk("contact.upsert", 1, { accountId: "rez:acct:carol", relationshipState: "active" }));
  await svc.applyInbound(mk("contact.upsert", 2, { accountId: "rez:acct:dave", relationshipState: "active" }));
  await svc.applyInbound(mk("activation.baselineComplete", 3, { activationId: "cert-1", horizonLamport: 2 }));

  assert.equal(calls.activation.length, 1);
  const routed = calls.activation[0];
  assert.equal(routed.activationId, "cert-1");
  assert.equal(routed.horizonLamport, 2);
  assert.equal(routed.seenBeforeLamport, 2, "all baseline events were folded before the marker");
});

test("applyInbound answers a baselineRequest DIRECTLY at the inbox the signed request names (throttled per activation)", async () => {
  const { svc, calls } = makeSyncHarness();
  const request = {
    op: "activation.baselineRequest", lamport: 1, originDeviceId: "rez:dev:new",
    originDevicePublicKeyB64: "newPub", payload: { activationId: "cert-1", requestInboxId: "inbox:new" }, issuedAtMs: 1, sig: "s",
  };
  await svc.applyInbound(request);
  const markerDeposits = calls.dispatch.filter((d) => d.event.op === "activation.baselineComplete");
  assert.equal(markerDeposits.length, 1, "the request was answered with a full baseline + marker");
  assert.equal(markerDeposits[0].address.inboxId, "inbox:new",
    "the answer targets the requester's named inbox, not the DeviceSet list");
  assert.equal(calls.dispatch.filter((d) => d.address.inboxId === "inbox:other-sib").length, 0);

  // Same-activation storm inside the throttle window: answered once.
  await svc.applyInbound({ ...request, lamport: 2 });
  const markersAfter = calls.dispatch.filter((d) => d.event.op === "activation.baselineComplete");
  assert.equal(markersAfter.length, 1, "throttled — a request loop cannot amplify");
});

test("applyInbound does NOT answer a baselineRequest that names no requester inbox (pre-fix requester) — and never falls back to the sibling list", async () => {
  const { svc, calls } = makeSyncHarness();
  const r = await svc.applyInbound({
    op: "activation.baselineRequest", lamport: 1, originDeviceId: "rez:dev:new",
    originDevicePublicKeyB64: "newPub", payload: { activationId: "cert-1" }, issuedAtMs: 1, sig: "s",
  });
  assert.equal(r.applied, true, "the event itself applies (idempotency cursor advances)");
  assert.equal(calls.dispatch.length, 0, "no baseline was sent anywhere");
});

test("applyInbound REFUSES a baselineRequest for a REVOKED activation cert, and DEFERS when own authority is unestablishable (M4: fail closed on the direct path)", async () => {
  const revoked = makeSyncHarness({
    ownAuthorityState: () => ({ established: true, revocationState: { revokedCertIds: ["cert-1"], minValidIssuedAtMs: 0 }, epoch: 2 }),
  });
  await revoked.svc.applyInbound({
    op: "activation.baselineRequest", lamport: 1, originDeviceId: "rez:dev:new",
    originDevicePublicKeyB64: "newPub", payload: { activationId: "cert-1", requestInboxId: "inbox:new" }, issuedAtMs: 1, sig: "s",
  });
  assert.equal(revoked.calls.dispatch.length, 0, "a revoked enrollment is never served a baseline");

  const unestablished = makeSyncHarness({
    ownAuthorityState: () => ({ established: false, reason: "fetch failed" }),
  });
  await unestablished.svc.applyInbound({
    op: "activation.baselineRequest", lamport: 1, originDeviceId: "rez:dev:new",
    originDevicePublicKeyB64: "newPub", payload: { activationId: "cert-1", requestInboxId: "inbox:new" }, issuedAtMs: 1, sig: "s",
  });
  assert.equal(unestablished.calls.dispatch.length, 0, "unestablishable authority defers — the stall loop re-asks");
});
