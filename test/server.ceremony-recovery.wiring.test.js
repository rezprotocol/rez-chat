import test from "node:test";
import assert from "node:assert/strict";
import { ChatServerApp } from "../src/server/app/ChatServerApp.js";
import { ServerDeviceLinkService } from "../src/server/services/ServerDeviceLinkService.js";
import { makeSealDispatch } from "./support/sealDispatchDouble.js";

// AUDIT FINDING #3 — the wiring guardrail.
//
// The finding was "listResumable()/listExpirable() have no production caller". A worker with
// excellent recovery logic that nothing ever starts reproduces that finding exactly, one layer
// down. So this boots the REAL app and asserts the lifecycle reaches the sweep, plus the
// serialization rule that a live ceremony defers it.

class TestKVStore {
  constructor() { this.map = new Map(); }
  async get(k) { return this.map.has(k) ? this.map.get(k) : null; }
  async set(k, v) { this.map.set(k, v); }
  async put(k, v) { this.map.set(k, v); }
  async delete(k) { this.map.delete(k); }
  async remove(k) { this.map.delete(k); }
  async list() { return { items: [] }; }
  async keys(prefix) {
    return [...this.map.keys()].filter((k) => typeof prefix !== "string" || k.startsWith(prefix));
  }
}

class TestStorageProvider {
  constructor() { this._stores = new Map(); }
  getKeyValueStore(name) {
    if (!this._stores.has(name)) this._stores.set(name, new TestKVStore());
    return this._stores.get(name);
  }
  getObjectStore() { return { deposit: async () => ({}), list: async () => [] }; }
  getMailboxStore() { return { deposit: async () => ({}), poll: async () => [] }; }
}

const FAKE_IDENTITY_KEYS = {
  publicKeyB64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  privateKeyB64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
};
const OWNER = "rez:acct:alice";

function makeApp() {
  const sdk = {
    ...makeSealDispatch({}),
    async connect() { return this; },
    async close() {},
    getIdentity: () => ({ localInboxId: "inbox:" + OWNER }),
    subscriptions: { onMailboxDeposited: () => () => {} },
    connectivity: { onReconnected: () => () => {} },
    mailbox: { ack: async () => ({}), list: async () => ({ items: [] }), fetch: async () => null },
    durableRecords: { put: async () => ({ localId: "slot", replicas: 1 }), get: async () => null },
    devices: { getAuthorityState: async () => ({ epoch: 1, revokedCertIds: [], minValidIssuedAtMs: 0 }) },
  };
  return new ChatServerApp({
    identity: { ...FAKE_IDENTITY_KEYS, accountId: OWNER, deviceId: "dev:" + OWNER },
    uplinks: ["ws://localhost:9999"],
    storageProvider: new TestStorageProvider(),
    ownerAccountId: OWNER,
    clock: () => 1_700_000_000_000,
    sdk,
  });
}

test("the platform-neutral app always registers the device-link recovery lifecycle", () => {
  const app = makeApp();
  const svc = app.bus.services.deviceLink;
  assert.ok(svc, "deviceLink is registered on the bus");
  assert.equal(typeof svc.start, "function", "and carries the lifecycle the app drives");
  assert.equal(typeof svc.stop, "function");
  assert.equal(typeof svc.recoverNow, "function", "with a non-throwing sweep entry point");
});

test("app.start() runs a ceremony-recovery sweep and arms the periodic one; app.stop() tears it down", async () => {
  // The whole finding in one assertion: without this, the journal reader exists and never runs.
  const app = makeApp();
  const svc = app.bus.services.deviceLink;

  const triggers = [];
  const realRecover = svc.recoverNow.bind(svc);
  svc.recoverNow = async (trigger) => { triggers.push(trigger); return realRecover(trigger); };

  await app.start();
  assert.deepEqual(triggers, ["startup"], "ChatServerApp.start() drives the sweep");
  assert.equal(svc.recoveryState.scheduled, true, "and the periodic sweep is armed behind it");

  await app.stop();
  assert.equal(svc.recoveryState.scheduled, false, "shutdown cancels the timer");
});

test("start() does not throw when this runtime cannot link devices at all", async () => {
  // No durableRecords/devices surface: nothing to recover, and boot must not fail over it.
  const sdk = {
    ...makeSealDispatch({}),
    async connect() { return this; },
    async close() {},
    getIdentity: () => ({ localInboxId: "inbox:" + OWNER }),
    subscriptions: { onMailboxDeposited: () => () => {} },
    connectivity: { onReconnected: () => () => {} },
    mailbox: { ack: async () => ({}), list: async () => ({ items: [] }), fetch: async () => null },
  };
  const app = new ChatServerApp({
    identity: { ...FAKE_IDENTITY_KEYS, accountId: OWNER, deviceId: "dev:" + OWNER },
    uplinks: ["ws://localhost:9999"],
    storageProvider: new TestStorageProvider(),
    ownerAccountId: OWNER,
    clock: () => 1_700_000_000_000,
    sdk,
    deviceLinkServiceFactory: ({ bus, storageProvider, ownerAccountId, clock, logger }) => (
      new ServerDeviceLinkService({ bus, storageProvider, ownerAccountId, clock, logger })
    ),
  });
  await app.start();
  try {
    assert.equal(app.bus.services.deviceLink.recoveryState.scheduled, true, "still re-checks later");
  } finally {
    await app.stop();
  }
});

// ── SERIALIZATION AGAINST A LIVE CEREMONY ──────────────────────────────────────────────────────

test("a live ceremony DEFERS the sweep — publication, confirmation and revoke cannot race", async () => {
  // The ceremony's critical section (persist → device.add → publish → markPublished) and its
  // confirmation poll both write the journal. A sweep inside either could republish a response the
  // approver is about to publish, or compensate a registration whose confirmation is a millisecond
  // away. Ceremonies are single-instance and deadline-bounded, so deferring cannot starve recovery.
  // Driving a REAL ceremony here would need the full approver crypto wiring, which this test is
  // not about. Instead it overrides the PROTECTED `_ceremonyIsActive()` seam — the repo's own
  // convention for behavior a subclass may specialise — so the deferral rule is exercised through
  // the same code path production uses, with no test-only backdoor in the service.
  let ceremonyState = null;
  class TestDeviceLinkService extends ServerDeviceLinkService {
    _ceremonyIsActive() {
      if (ceremonyState === null) return super._ceremonyIsActive();
      return ceremonyState !== "done" && ceremonyState !== "failed" && ceremonyState !== "expired"
        && ceremonyState !== "cancelled" && ceremonyState !== "confirmed";
    }
  }

  const scheduled = [];
  const svc = new TestDeviceLinkService({
    bus: {
      runtime: {
        sdk: {
          durableRecords: { put: async () => ({}) },
          devices: { getAuthorityState: async () => ({ epoch: 1, revokedCertIds: [], minValidIssuedAtMs: 0 }) },
        },
      },
      on: () => () => {},
      emit() {},
      registerFunction() {},
      call: async () => null,
    },
    ownerAccountId: OWNER,
    storageProvider: new TestStorageProvider(),
    clock: () => 1000,
    logger: { info() {}, warn() {}, error() {} },
    setTimer: (fn, ms) => { scheduled.push(ms); return scheduled.length; },
    clearTimer: () => {},
  });

  // No ceremony: the sweep runs and re-arms at the normal cadence.
  const ran = await svc.recoverNow("startup");
  assert.ok(ran !== null, "swept");
  assert.equal(scheduled.at(-1), 120_000);

  // Pretend a ceremony is live. recoverNow must decline and come back sooner.
  ceremonyState = "pending";
  const deferred = await svc.recoverNow("periodic");
  assert.equal(deferred, null, "the sweep deferred to the live ceremony");
  assert.equal(scheduled.at(-1), 15_000, "and re-armed on the shorter deferred interval");

  // Once the ceremony reaches a terminal state the sweep resumes.
  ceremonyState = "confirmed";
  assert.ok(await svc.recoverNow("periodic") !== null);
  assert.equal(scheduled.at(-1), 120_000);
  await svc.stop();
});
