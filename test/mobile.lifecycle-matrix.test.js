// M7 — the adversarial lifecycle matrix (plans/MOBILE_LIFECYCLE_ADAPTER_PLAN
// §4 M7, under the §7f pins). Host-agnostic by design: suspend / kill / wake
// / network-change / time-advance are simulated against the runtime hooks —
// no APNs, no background budgets, no platform scheduling.
//
// The stack under test is a REAL ChatServerApp in CLAIMANT mode (every
// service, the real bus, the real InboxCatchupService/ServerRuntimeService
// wiring, the REAL sdk InboxClaimStore with real crypto) over a scripted
// provider: a fake sdk whose network can drop, whose INBOX_CLAIM answers are
// scriptable (acceptance, reclaimed refusals), and whose mailbox holds
// items. Real-transport equivalents of the boot rows are anchored by the M1
// kill shot (real node, real pool); the commit-sweep and sibling-sync
// INTERNALS are proven in their own suites — here the matrix proves the
// adapter DRIVES them on wake.
//
// The frozen success condition this file exists for:
//   "A phone can be arbitrarily suspended between wakes, and every
//    correctness decision is reconstructed from durable state when it
//    returns, using claimant-mode data-plane access only."

import test from "node:test";
import assert from "node:assert/strict";
import { NodeCryptoProvider } from "@rezprotocol/node";
import { bytesToBase64, nodeKeyIdForNodePublicKeyB64, relayKeyIdForNodePublicKeyB64 } from "@rezprotocol/core";
import { InboxClaimStore } from "@rezprotocol/sdk/client";

import { ChatServerApp } from "../src/server/app/ChatServerApp.js";
import { MobileLifecycleAdapter } from "../src/server/runtime/MobileLifecycleAdapter.js";

const CRYPTO = new NodeCryptoProvider();
const QUIET = { log() {}, warn() {}, info() {}, error() {} };
const OWNER = "rez:acct:matrix";
const DAY = 24 * 60 * 60 * 1000;

const NODE_IDENTITY = (() => {
  const kp = CRYPTO.generateSigningKeyPair();
  const nodePublicKeyB64 = bytesToBase64(kp.publicKey);
  return {
    nodeKeyId: nodeKeyIdForNodePublicKeyB64(nodePublicKeyB64),
    nodePublicKeyB64,
    relayKeyId: relayKeyIdForNodePublicKeyB64(nodePublicKeyB64),
  };
})();

class TestKVStore {
  constructor() { this._data = new Map(); }
  async get(key) { return this._data.has(key) ? this._data.get(key) : null; }
  async getStrict(key) { return this._data.has(key) ? this._data.get(key) : undefined; }
  async set(key, value) { this._data.set(key, JSON.parse(JSON.stringify(value))); }
  async delete(key) { this._data.delete(key); }
  async keys(prefix) {
    const out = [];
    for (const k of this._data.keys()) if (k.startsWith(prefix)) out.push(k);
    return out;
  }
}
class TestStorageProvider {
  constructor() { this._stores = new Map(); }
  getKeyValueStore(name) {
    if (!this._stores.has(name)) this._stores.set(name, new TestKVStore());
    return this._stores.get(name);
  }
}

function retryableErr(code) {
  const err = new Error(code);
  err.code = code;
  err.retryable = true;
  return err;
}

function reclaimedErr(finalGeneration) {
  const err = new Error("inbox generation was reclaimed after lease expiry");
  err.code = "INBOX_CLOSED";
  err.retryable = false;
  err.detail = { closeReason: "reclaimed", finalGeneration };
  return err;
}

// The scripted provider: network toggle, pool-state emission, awaited
// reconnect hooks (the UplinkPool contract), scriptable claim answers, and a
// mailbox whose items drain via the real list/fetch/ack model.
function makeScriptedSdk() {
  const state = {
    online: true,
    claims: [],           // every INBOX_CLAIM body sent
    claimAnswers: [],     // scripted answers (Error) — empty = accept
    items: [],            // mailbox items [{eventId}]
    fetched: new Map(),   // eventId -> ciphertextB64
    acked: [],
    listed: 0,
  };
  const reconnectHandlers = [];
  let poolStateHandler = null;
  const sdk = {
    async connect() {
      if (!state.online) throw retryableErr("UNREACHABLE");
    },
    async close() {},
    onPoolState(handler) { poolStateHandler = handler; return () => { poolStateHandler = null; }; },
    connectivity: {
      onReconnected(handler) {
        reconnectHandlers.push(handler);
        return () => {
          const i = reconnectHandlers.indexOf(handler);
          if (i >= 0) reconnectHandlers.splice(i, 1);
        };
      },
      async connectNow() {
        if (!state.online) throw retryableErr("UNREACHABLE");
        for (const handler of [...reconnectHandlers]) await handler();
      },
    },
    getSessionInfo() {
      if (!state.online) return null;
      return { ...NODE_IDENTITY, capabilities: {} };
    },
    async sendRequest(req) {
      if (!state.online) throw retryableErr("UNREACHABLE");
      state.claims.push(req.body);
      const answer = state.claimAnswers.shift();
      if (answer instanceof Error) throw answer;
      return { body: {} };
    },
    subscriptions: { onMailboxDeposited() { return () => {}; }, onEvent() { return () => {}; } },
    mailbox: {
      async list() {
        if (!state.online) throw retryableErr("NOT_READY");
        state.listed += 1;
        return { items: state.items.slice() };
      },
      async fetch({ eventId }) {
        return { ciphertextB64: state.fetched.get(eventId) || "" };
      },
      async ack({ eventId }) {
        state.acked.push(eventId);
        const idx = state.items.findIndex((i) => i.eventId === eventId);
        if (idx >= 0) state.items.splice(idx, 1);
      },
    },
    // Seal/dispatch surfaces some services probe for; inert here.
    sealForPeer: async () => ({ object: {}, address: {} }),
    mesh: { async dispatch() {} },
    getIdentity: () => ({ localInboxId: "" }),
    node: { async status() { return { mesh: {} }; } },
  };
  return {
    sdk,
    state,
    async fireReconnected() {
      for (const handler of [...reconnectHandlers]) await handler();
    },
    emitPoolState(payload) {
      if (poolStateHandler) poolStateHandler(payload);
    },
  };
}

// A REAL claim store (real crypto, real lease persistence) shared across app
// "restarts" via its storage provider — the phone's durable state.
async function makeClaimStore(storageProvider = new TestStorageProvider()) {
  const store = new InboxClaimStore({ storageProvider, cryptoProvider: CRYPTO });
  await store.hydrate();
  let claim = null;
  // Rehydration path: reuse the persisted claim if one exists.
  if (store.size() === 0) {
    claim = await store.createClaim();
    await store.persist(claim);
  } else {
    const [existing] = store.listRedacted();
    claim = existing;
  }
  return { store, inboxId: claim.inboxId, storageProvider };
}

// The full app: claimant mode, injectable clock, decrypt-everything pipeline
// (matrix rows are about lifecycle, not crypto — crypto rows live in the
// e2e suites).
async function makeApp({ sdkPack, claimPack, storage = new TestStorageProvider(), nowRef }) {
  const app = new ChatServerApp({
    identity: { accountId: OWNER, deviceId: "dev:matrix", publicKeyB64: "p", privateKeyB64: "s" },
    uplinks: ["ws://scripted-node"],
    storageProvider: storage,
    ownerAccountId: OWNER,
    clock: () => nowRef.now,
    sdk: sdkPack.sdk,
    inboxClaimant: { inboxId: claimPack.inboxId, claimStore: claimPack.store },
    sessionMode: "claimant",
    logger: QUIET,
  });
  // The matrix drains real frames through the real pipeline; consumed=true is
  // enough (decrypt correctness is out of scope here).
  app.bus.services.inboundPipeline.submit = async () => ({ consumed: true, decryptOk: true, durable: true });
  const events = [];
  app.on("mailbox.remint", (e) => events.push({ name: "mailbox.remint", ...e }));
  app.on("inbox.caughtup", (e) => events.push({ name: "inbox.caughtup", ...e }));
  const adapter = new MobileLifecycleAdapter({
    bus: app.bus,
    suspendAccountControl: app.bus.runtime.accountControl
      ? () => app.bus.runtime.accountControl.suspend()
      : null,
    logger: QUIET,
  });
  return { app, adapter, events };
}

test("MATRIX: cold start (online) → converge — bind, drain, sweep, sync all self-decide; zero account authority", async () => {
  const nowRef = { now: Date.now() };
  const sdkPack = makeScriptedSdk();
  const claimPack = await makeClaimStore();
  const { app, adapter } = await makeApp({ sdkPack, claimPack, nowRef });
  await app.start();

  const report = await adapter.onForeground();
  assert.equal(report.live, true);
  for (const [label, step] of Object.entries(report.steps)) {
    assert.equal(step.ok, true, label + ": " + JSON.stringify(step));
  }
  assert.equal(report.steps.renewLeaseIfDue.result.renewed, false, "fresh lease — not due");
  assert.ok(sdkPack.state.listed >= 1, "the wake forced a drain");
  assert.equal(app.bus.runtime.accountControl.executeCount, 0);
  await app.stop();
});

test("MATRIX: cold start (offline) → services start → network appears → onNetworkAvailable converges WITHOUT process restart", async () => {
  const nowRef = { now: Date.now() };
  const sdkPack = makeScriptedSdk();
  sdkPack.state.online = false;
  const claimPack = await makeClaimStore();
  const { app, adapter } = await makeApp({ sdkPack, claimPack, nowRef });

  await app.start(); // M1: boots offline, every service started
  assert.equal(app.bus.services.runtime.connected, false);

  // Wake while STILL offline: short-circuits, reports, never throws.
  const offlineReport = await adapter.onPeriodicWake();
  assert.equal(offlineReport.live, false);

  sdkPack.state.online = true;
  const report = await adapter.onNetworkAvailable();
  assert.equal(report.live, true, "the wake IS the liveness signal — no timer needed");
  assert.equal(app.bus.services.runtime.connected, true);
  assert.equal(sdkPack.state.claims.length, 1, "the bind completed on the wake");
  assert.equal(app.bus.runtime.accountControl.executeCount, 0);
  await app.stop();
});

test("MATRIX: foreground → background → foreground — background suspends account control (no-op without a session) and never converges", async () => {
  const nowRef = { now: Date.now() };
  const sdkPack = makeScriptedSdk();
  const claimPack = await makeClaimStore();
  const { app, adapter } = await makeApp({ sdkPack, claimPack, nowRef });
  await app.start();
  await adapter.onForeground();
  const listedBefore = sdkPack.state.listed;

  const bg = await adapter.onBackground();
  assert.deepEqual(bg, { suspended: false, reason: "no-session" }, "idempotent no-op — no account session ever existed");
  assert.equal(sdkPack.state.listed, listedBefore, "backgrounding is a stand-down, not a wake");

  const report = await adapter.onForeground();
  assert.equal(report.live, true);
  assert.equal(app.bus.runtime.accountControl.executeCount, 0);
  await app.stop();
});

test("MATRIX: killed while backgrounded → cold restart over the SAME durable state — unacked mail drains, lease state survives, converge is clean", async () => {
  const nowRef = { now: Date.now() };
  const storage = new TestStorageProvider();
  const claimStorage = new TestStorageProvider();
  const claimPack1 = await makeClaimStore(claimStorage);

  // Life 1: boot, bind (records the accepted lease durably), then KILL (no
  // stop() — a killed process says no goodbyes).
  const sdkPack1 = makeScriptedSdk();
  const life1 = await makeApp({ sdkPack: sdkPack1, claimPack: claimPack1, storage, nowRef });
  await life1.app.start();
  await life1.adapter.onForeground();
  assert.ok(claimPack1.store.leaseState(claimPack1.inboxId), "the accepted lease persisted durably");

  // Mail deposited while dead; provider buffer holds it (unacked = safe).
  const sdkPack2 = makeScriptedSdk();
  sdkPack2.state.items = [{ eventId: "evt:while-dead" }];
  sdkPack2.state.fetched.set("evt:while-dead", "Y2lwaGVydGV4dA==");

  // Life 2: a fresh process over the SAME storage + claim store.
  const claimPack2 = await makeClaimStore(claimStorage);
  assert.equal(claimPack2.inboxId, claimPack1.inboxId, "the durable claim (and address) survived the kill");
  const life2 = await makeApp({ sdkPack: sdkPack2, claimPack: claimPack2, storage, nowRef });
  await life2.app.start();
  const report = await life2.adapter.onForeground();
  assert.equal(report.live, true);
  assert.deepEqual(sdkPack2.state.acked, ["evt:while-dead"], "the while-dead deposit was drained + acked");
  assert.equal(life2.app.bus.runtime.accountControl.executeCount, 0);
  await life2.app.stop();
});

test("MATRIX: wake after lease expiry inside grace — renew-before-drain preserves buffered mail; derived from durable lease + now, no timer fired", async () => {
  const nowRef = { now: Date.now() };
  const sdkPack = makeScriptedSdk();
  const claimPack = await makeClaimStore();
  const { app, adapter } = await makeApp({ sdkPack, claimPack, nowRef });
  await app.start(); // bind at t0 records the accepted 7d lease
  const claimsAfterBoot = sdkPack.state.claims.length;
  const leaseBefore = claimPack.store.leaseState(claimPack.inboxId);

  // The phone sleeps 8 days: past expiry (7d), inside the provider's grace.
  // Mail is waiting. NO timer fired anywhere during those 8 days.
  nowRef.now += 8 * DAY;
  sdkPack.state.items = [{ eventId: "evt:graced" }];
  sdkPack.state.fetched.set("evt:graced", "bWFpbA==");

  const report = await adapter.onPushWake();
  assert.equal(report.live, true);
  assert.equal(report.steps.renewLeaseIfDue.result.renewed, true, "renewal derived from durable lease + now");
  assert.equal(sdkPack.state.claims.length, claimsAfterBoot + 1, "the renewal is the claim/reattest round-trip");
  const leaseAfter = claimPack.store.leaseState(claimPack.inboxId);
  assert.ok(leaseAfter.expiresAtMs > leaseBefore.expiresAtMs, "fresh accepted window recorded");
  assert.deepEqual(sdkPack.state.acked, ["evt:graced"], "renew ran BEFORE drain — the buffered mail was preserved and consumed");
  await app.stop();
});

test("MATRIX: reclaimed while dark (30d) → wake re-mints on provider evidence, address survives, converge continues to drain — zero account sessions", async () => {
  const nowRef = { now: Date.now() };
  const sdkPack = makeScriptedSdk();
  const claimPack = await makeClaimStore();
  const { app, adapter, events } = await makeApp({ sdkPack, claimPack, nowRef });
  await app.start();

  // 30 days dark: the provider reclaimed generation 1. The wake's renewal
  // attempt is refused with the typed reclaimed detail; the runtime re-mints
  // gen 2 and retries — the third scripted answer accepts it.
  nowRef.now += 30 * DAY;
  sdkPack.state.claimAnswers = [reclaimedErr(1)];
  sdkPack.state.items = [{ eventId: "evt:post-remint" }];
  sdkPack.state.fetched.set("evt:post-remint", "bmV3");

  const report = await adapter.onPushWake();
  assert.equal(report.live, true);
  assert.equal(report.steps.renewLeaseIfDue.result.renewed, true, "the re-minted claim was accepted as the renewal");
  const remints = events.filter((e) => e.name === "mailbox.remint");
  assert.equal(remints.length, 1, "the DISTINCT re-mint event fired — never reported as a plain renewal");
  assert.equal(remints[0].fromGeneration, 1);
  assert.equal(remints[0].toGeneration, 2);
  assert.equal(claimPack.store.get(claimPack.inboxId).generation, 2);
  assert.deepEqual(sdkPack.state.acked, ["evt:post-remint"],
    "the converge continued past the re-mint — new deposits at the SAME address drain (peers' commit slow-tail heals the rest)");
  assert.equal(app.bus.runtime.accountControl.executeCount, 0, "address recovery is pure data plane");
  await app.stop();
});

test("MATRIX: provider restart while the device slept — the wake re-binds (reattestation) and drains; commit sweep + sibling sync are driven every converge", async () => {
  const nowRef = { now: Date.now() };
  const sdkPack = makeScriptedSdk();
  const claimPack = await makeClaimStore();
  const { app, adapter } = await makeApp({ sdkPack, claimPack, nowRef });
  await app.start();
  const claimsAfterBoot = sdkPack.state.claims.length;

  // Spy on the two repair directives (their INTERNALS are proven in the
  // commit-ack and sibling-sync suites; the matrix proves the adapter DRIVES
  // them on wake).
  const driven = [];
  for (const [ns, name] of [["message.commit", "sweep"], ["sibling-sync", "syncAll"]]) {
    const real = app.bus.functions[ns][name];
    app.bus.functions[ns][name] = async (payload) => { driven.push(ns + "." + name); return real(payload); };
  }

  // The provider restarted while the device slept: its session is gone. The
  // pool's replacement transport fires the awaited reconnect hooks — pool
  // phase reports reconnecting, and ensureLive's kick completes the re-bind.
  sdkPack.emitPoolState({ phase: "reconnecting", reason: "provider restarted" });
  const report = await adapter.onNetworkAvailable();
  assert.equal(report.live, true);
  assert.equal(sdkPack.state.claims.length, claimsAfterBoot + 1, "the re-bind replayed the inbox claim (reattestation)");
  assert.deepEqual(driven, ["message.commit.sweep", "sibling-sync.syncAll"],
    "pending-commit rows and sibling gaps accumulated while dead are swept from durable state + now on every wake");
  await app.stop();
});

test("MATRIX: network drops DURING a wake → that pass short-circuits cleanly; the next wake converges — nothing poisoned, nothing thrown", async () => {
  const nowRef = { now: Date.now() };
  const sdkPack = makeScriptedSdk();
  const claimPack = await makeClaimStore();
  const { app, adapter } = await makeApp({ sdkPack, claimPack, nowRef });
  await app.start();

  sdkPack.emitPoolState({ phase: "offline", reason: "carrier dropped" });
  sdkPack.state.online = false;
  const failed = await adapter.onPushWake(); // must not throw at the host
  assert.equal(failed.live, false);
  assert.equal(failed.steps.ensureLive.ok, false);
  assert.equal(failed.steps.drain, undefined, "nothing after the gate ran");

  sdkPack.state.online = true;
  const report = await adapter.onNetworkAvailable();
  assert.equal(report.live, true);
  for (const [label, step] of Object.entries(report.steps)) {
    assert.equal(step.ok, true, label);
  }
  assert.equal(app.bus.runtime.accountControl.executeCount, 0);
  await app.stop();
});

test("MATRIX compound (the I7 shape): dark 8 days in grace + provider restart + wake storm — one coalesced recovery, primary/root offline THROUGHOUT, zero account frames", async () => {
  const nowRef = { now: Date.now() };
  const sdkPack = makeScriptedSdk();
  const claimPack = await makeClaimStore();
  const { app, adapter } = await makeApp({ sdkPack, claimPack, nowRef });
  await app.start();
  const claimsAfterBoot = sdkPack.state.claims.length;

  // Everything at once: 8 days dark (renewal due), the provider restarted
  // (session gone), mail waiting, and the host fires a storm of wakes.
  nowRef.now += 8 * DAY;
  sdkPack.emitPoolState({ phase: "reconnecting", reason: "provider restarted" });
  sdkPack.state.items = [{ eventId: "evt:compound" }];
  sdkPack.state.fetched.set("evt:compound", "Y29tcG91bmQ=");

  const first = adapter.onNetworkAvailable();
  adapter.onPushWake();
  adapter.onForeground();
  const report = await first;

  assert.equal(report.live, true);
  // Re-bind (reconnect hook) + renewal both happened; the storm coalesced
  // into at most two passes (one + the dirty-bit rerun).
  assert.ok(sdkPack.state.claims.length >= claimsAfterBoot + 1, "re-bound and renewed");
  assert.deepEqual(sdkPack.state.acked, ["evt:compound"], "mail preserved through expiry-in-grace and drained");
  // The PRIMARY/root device was offline for the entire scenario: this
  // claimant runtime never held an account key, never opened an account
  // session, and never needed either.
  assert.equal(app.bus.runtime.accountControl.executeCount, 0, "zero account authority across the whole recovery");
  await app.stop();
});
