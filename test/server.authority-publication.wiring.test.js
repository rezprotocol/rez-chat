import test from "node:test";
import assert from "node:assert/strict";
import { ChatServerApp } from "../src/server/app/ChatServerApp.js";
import { makeSealDispatch } from "./support/sealDispatchDouble.js";

// AUDIT FINDING #2 — the wiring guardrail.
//
// The finding was not "the drain worker is wrong", it was "nothing calls it on a schedule". A
// service-level test of the retry logic would pass just as happily if ChatServerApp never started
// the service — the bug would simply have moved from the worker to the wiring. So this asserts the
// production path end to end: booting the app arms the recovery net, and stopping it tears it down.
//
// Deliberately app-level and free of any drain mechanics: the outcomes are covered in
// server.authority-publication.service.test.js. What is pinned here is only that the service is
// reachable, is started, and is stopped by the real lifecycle.

class TestKVStore {
  constructor() { this.map = new Map(); }
  async get(k) { return this.map.has(k) ? this.map.get(k) : null; }
  async set(k, v) { this.map.set(k, v); }
  async put(k, v) { this.map.set(k, v); }
  async delete(k) { this.map.delete(k); }
  async remove(k) { this.map.delete(k); }
  async list() { return { items: [] }; }
  async keys() { return [...this.map.keys()]; }
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
  // The minimum SDK the runtime service needs to reach the service-start loop. Deliberately has NO
  // accountOutbox: this is the fs / desktop shape, where the drain is 'disabled'.
  const sdk = {
    ...makeSealDispatch({}),
    async connect() { return this; },
    async close() {},
    getIdentity: () => ({ localInboxId: "inbox:" + OWNER }),
    sendSealed: async () => ({}),
    subscriptions: { onMailboxDeposited: () => () => {} },
    connectivity: { onReconnected: () => () => {} },
    mailbox: {
      ack: async () => ({}),
      list: async () => ({ items: [] }),
      fetch: async () => null,
    },
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

test("the app EXPOSES the authority-publication recovery worker", () => {
  const app = makeApp();
  const svc = app.bus.services.authorityPublication;
  assert.ok(svc, "authorityPublication is registered on the bus");
  assert.equal(typeof svc.start, "function", "and carries the lifecycle the app drives");
  assert.equal(typeof svc.stop, "function");
  assert.equal(typeof svc.requestDrain, "function", "with a non-throwing self-driven entry point");
});

test("app.start() STARTS the recovery worker, and app.stop() stops it", async () => {
  // The whole finding in one assertion: without this, the retry logic exists and never runs.
  const app = makeApp();
  const svc = app.bus.services.authorityPublication;

  let started = 0;
  let stopped = 0;
  const realStart = svc.start.bind(svc);
  const realStop = svc.stop.bind(svc);
  svc.start = async () => { started += 1; return realStart(); };
  svc.stop = async () => { stopped += 1; return realStop(); };

  await app.start();
  assert.equal(started, 1, "ChatServerApp.start() drives the recovery worker's start()");

  await app.stop();
  assert.equal(stopped, 1, "and shutdown tears it down");
});

test("a boot with no outbox surface SUSPENDS instead of leaving a timer running", async () => {
  // This wiring has no sdk.accountOutbox, so the drain is 'disabled'. The worker must recognise
  // that polling cannot help and stand down — otherwise every desktop/fs boot would hold a
  // pointless repeating timer forever.
  const app = makeApp();
  await app.start();
  try {
    const state = app.bus.services.authorityPublication.recoveryState;
    assert.equal(state.suspendedReason, "disabled");
    assert.equal(state.scheduled, false, "no timer left armed");
  } finally {
    await app.stop();
  }
});
