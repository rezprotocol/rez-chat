// M1 (plans/MOBILE_LIFECYCLE_ADAPTER_PLAN.md) — offline-tolerant boot +
// reconnect-completes-the-bind.
//
// The T1 gap this pins: ChatServerApp.start() used to await runtime.connect()
// before any service started, and #restoreAfterReconnect early-returned unless
// the first connect had already succeeded — so an offline cold start was not
// "degraded, converges later", it was dead until a full process restart with
// network. Mobile's frozen M1 rule (plan §7): offline cold boot must start ALL
// services in a DISCONNECTED state, and the app/runtime must be fully
// recoverable without process restart — network appears → the pool's background
// reconnect completes the full bind.
//
// Terminal refusals stay loud: only errors carrying `retryable === true` (the
// pool's network-shaped codes) defer the bind. A refused home is not an
// unreachable home.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { bytesToBase64 } from "@rezprotocol/core";
import { NodeCryptoProvider, startRezNode } from "@rezprotocol/node";

import { ChatServerApp } from "../src/server/app/ChatServerApp.js";
import { ServerRuntimeService } from "../src/server/services/ServerRuntimeService.js";
import { InboxCatchupService } from "../src/server/services/InboxCatchupService.js";
import { InboxClaimant } from "../src/server/inbox/InboxClaimant.js";
import { makeSealDispatch } from "./support/sealDispatchDouble.js";

const INBOX = "rez:inbox:chat-server";
const QUIET_LOGGER = { log() {}, warn() {}, info() {}, error() {} };

function retryableErr(code) {
  const err = new Error(code || "UNREACHABLE");
  err.code = code || "UNREACHABLE";
  err.retryable = true;
  return err;
}

function terminalErr(code) {
  const err = new Error(code || "DELEGATED_DEVICES_UNSUPPORTED");
  err.code = code || "DELEGATED_DEVICES_UNSUPPORTED";
  err.retryable = false;
  return err;
}

function makeBus() {
  const handlers = new Map();
  const events = [];
  return {
    events,
    runtime: {},
    stores: {},
    functions: {},
    services: { inboundPipeline: { submit: async () => ({ status: "noop" }) } },
    resolveReady: { runtime() {} },
    on(name, fn) {
      if (!handlers.has(name)) handlers.set(name, new Set());
      handlers.get(name).add(fn);
      return () => handlers.get(name).delete(fn);
    },
    emit(name, payload) {
      events.push({ name, payload });
      const listeners = handlers.get(name);
      if (!listeners) return;
      for (const listener of [...listeners]) listener(payload);
    },
    registerFunction() {},
    call() { return Promise.resolve(null); },
  };
}

function makeInboxClaimant() {
  return {
    inboxId: INBOX,
    claimStore: {
      async createReattestation(inboxId) {
        return { inboxId, claimantPublicKeyB64: "claimant-pub", claimedAtMs: 1000, claimSignatureB64: "claim-sig" };
      },
      async createNodeDelegation({ inboxId, nodeKeyId, nodePublicKeyB64, relayKeyId }) {
        return { inboxId, nodeKeyId, nodePublicKeyB64, relayKeyId, issuedAtMs: 1000, expiresAtMs: 9_000_000_000_000, delegationSigB64: "deleg-sig" };
      },
    },
  };
}

// A fake sdk with a network toggle. While `online === false`, connect() and
// mailbox reads fail with the pool's retryable shapes; flipping online and
// firing the captured onReconnected handlers (in registration order, awaited —
// exactly what UplinkPool#notifyReconnected does) simulates the pool's
// background reconnect finding the home.
function makeToggleSdk() {
  const state = { online: false, connectAttempts: 0, claims: [], listed: 0 };
  const reconnectHandlers = [];
  const sdk = {
    async connect() {
      state.connectAttempts += 1;
      if (!state.online) throw retryableErr("UNREACHABLE");
    },
    async close() {},
    connectivity: {
      onReconnected(handler) {
        reconnectHandlers.push(handler);
        return () => {
          const i = reconnectHandlers.indexOf(handler);
          if (i >= 0) reconnectHandlers.splice(i, 1);
        };
      },
    },
    getSessionInfo() {
      if (!state.online) return null;
      return { nodeKeyId: "node-key", nodePublicKeyB64: "node-pub", relayKeyId: "relay-key", capabilities: {} };
    },
    async sendRequest(req) {
      state.claims.push(req);
      return { body: {} };
    },
    subscriptions: {
      onMailboxDeposited() { return () => {}; },
      onEvent() { return () => {}; },
    },
    mailbox: {
      async list() {
        if (!state.online) throw retryableErr("NOT_READY");
        state.listed += 1;
        return { items: [] };
      },
      async fetch() { throw new Error("unexpected fetch: list returned no items"); },
      async ack() {},
    },
  };
  return {
    sdk,
    state,
    async fireReconnected() {
      for (const handler of [...reconnectHandlers]) {
        await handler();
      }
    },
  };
}

function makeRuntime({ sdk }) {
  const bus = makeBus();
  const svc = new ServerRuntimeService({
    bus,
    identity: { accountId: "rez:acct:chat", deviceId: "dev:chat", publicKeyB64: "p", privateKeyB64: "s" },
    uplinks: ["ws://node"],
    sdk,
    inboxClaimant: makeInboxClaimant(),
    logger: QUIET_LOGGER,
  });
  return { svc, bus };
}

// ---- ServerRuntimeService unit coverage ----

test("M1: a retryable connect failure arms the pending bind; the first pool reconnect completes the FULL first-connect sequence", async () => {
  const { sdk, state, fireReconnected } = makeToggleSdk();
  const { svc, bus } = makeRuntime({ sdk });

  await assert.rejects(svc.connect(), (err) => err.retryable === true);
  assert.equal(svc.connected, false);
  assert.equal(state.claims.length, 0, "no claim was sent while offline");

  state.online = true;
  await fireReconnected();

  assert.equal(svc.connected, true, "the reconnect completed the bind");
  assert.equal(state.claims.length, 1, "the inbox claim ran exactly once, on the completing reconnect");
  assert.ok(bus.events.some((e) => e.name === "runtime.connected"), "runtime.connected announced");
  const states = bus.events.filter((e) => e.name === "connection.state").map((e) => e.payload.status);
  assert.equal(states[states.length - 1], "connected");
});

test("M1: a terminal (non-retryable) failure does NOT arm the pending bind — a later reconnect must not resurrect a refused session", async () => {
  const { sdk, state, fireReconnected } = makeToggleSdk();
  sdk.connect = async () => { throw terminalErr("DELEGATED_DEVICES_UNSUPPORTED"); };
  const { svc } = makeRuntime({ sdk });

  await assert.rejects(svc.connect(), (err) => err.code === "DELEGATED_DEVICES_UNSUPPORTED");

  state.online = true;
  await fireReconnected();
  assert.equal(svc.connected, false, "no bind: the refusal was on the merits, not the network");
  assert.equal(state.claims.length, 0);
});

test("M1: disconnect() stands a pending bind down — a stopped runtime can never late-bind from a stale reconnect", async () => {
  const { sdk, state, fireReconnected } = makeToggleSdk();
  const { svc } = makeRuntime({ sdk });

  await assert.rejects(svc.connect(), (err) => err.retryable === true);
  await svc.disconnect();

  state.online = true;
  await fireReconnected();
  assert.equal(svc.connected, false);
  assert.equal(state.claims.length, 0);
});

test("M1: concurrent connect() callers share one in-flight attempt", async () => {
  const { sdk, state } = makeToggleSdk();
  state.online = true;
  let release = null;
  const gate = new Promise((resolve) => { release = resolve; });
  const realConnect = sdk.connect;
  sdk.connect = async () => { await gate; return realConnect(); };
  const { svc } = makeRuntime({ sdk });

  const first = svc.connect();
  const second = svc.connect();
  release();
  await Promise.all([first, second]);

  assert.equal(state.connectAttempts, 1, "sdk.connect ran once for both callers");
  assert.equal(state.claims.length, 1, "one bind, not two");
  assert.equal(svc.connected, true);
});

// ---- InboxCatchupService start tolerance ----

test("M1: catchup start() defers the initial drain on a retryable failure — and does NOT claim inbox.caughtup", async () => {
  const { sdk } = makeToggleSdk();
  const bus = makeBus();
  bus.runtime.sdk = sdk;
  const svc = new InboxCatchupService({
    bus,
    inboxClaimant: makeInboxClaimant(),
    inboundPipeline: { submit: async () => ({ status: "noop" }) },
    periodicDrainMs: 0,
    logger: QUIET_LOGGER,
  });
  await svc.start();
  assert.equal(bus.events.some((e) => e.name === "inbox.caughtup"), false,
    "a drain that never ran must not report caught-up");
  await svc.stop();
});

test("M1: catchup start() still fails loudly on a non-retryable drain error", async () => {
  const { sdk, state } = makeToggleSdk();
  state.online = true;
  sdk.mailbox.list = async () => { throw new Error("mailbox store corrupt"); };
  const bus = makeBus();
  bus.runtime.sdk = sdk;
  const svc = new InboxCatchupService({
    bus,
    inboxClaimant: makeInboxClaimant(),
    inboundPipeline: { submit: async () => ({ status: "noop" }) },
    periodicDrainMs: 0,
    logger: QUIET_LOGGER,
  });
  await assert.rejects(svc.start(), /mailbox store corrupt/);
  await svc.stop();
});

// ---- ChatServerApp: the M1 lifecycle, end to end over fakes ----

class TestKVStore {
  constructor() { this._data = new Map(); }
  async get(key) { return this._data.has(key) ? this._data.get(key) : null; }
  async getStrict(key) { return this._data.has(key) ? this._data.get(key) : undefined; }
  async set(key, value) { this._data.set(key, value); }
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

test("M1: ChatServerApp boots offline — every service starts, state is offline, and the pool reconnect converges it (bind + drain) without restart", async () => {
  const { sdk, state, fireReconnected } = makeToggleSdk();
  const fullSdk = { ...makeSealDispatch({}), ...sdk, getIdentity: () => ({ localInboxId: INBOX }) };
  const app = new ChatServerApp({
    identity: { accountId: "rez:acct:m1", deviceId: "dev:m1", publicKeyB64: "p", privateKeyB64: "s" },
    uplinks: ["ws://unreachable"],
    storageProvider: new TestStorageProvider(),
    ownerAccountId: "rez:acct:m1",
    sdk: fullSdk,
    inboxClaimant: makeInboxClaimant(),
    logger: QUIET_LOGGER,
  });

  const seen = [];
  app.on("server.ready", () => seen.push("server.ready"));
  app.on("runtime.connected", () => seen.push("runtime.connected"));
  const caughtUp = new Promise((resolve) => app.on("inbox.caughtup", resolve));

  await app.start();
  assert.ok(seen.includes("server.ready"), "boot completed offline");
  assert.equal(app.bus.services.runtime.connected, false);
  assert.equal(seen.includes("runtime.connected"), false);
  assert.equal(state.claims.length, 0, "no network work happened while offline");

  state.online = true;
  await fireReconnected();

  assert.equal(app.bus.services.runtime.connected, true, "the reconnect completed the bind");
  assert.ok(seen.includes("runtime.connected"));
  assert.equal(state.claims.length, 1, "inbox claim registered on the completing reconnect");
  await caughtUp;
  assert.ok(state.listed >= 1, "the deferred initial drain ran once a session existed");

  await app.stop();
});

test("M1: ChatServerApp.start() still fails loudly when the home REFUSES (terminal code)", async () => {
  const { sdk } = makeToggleSdk();
  sdk.connect = async () => { throw terminalErr("DELEGATED_DEVICES_UNSUPPORTED"); };
  const fullSdk = { ...makeSealDispatch({}), ...sdk, getIdentity: () => ({ localInboxId: INBOX }) };
  const app = new ChatServerApp({
    identity: { accountId: "rez:acct:m1b", deviceId: "dev:m1b", publicKeyB64: "p", privateKeyB64: "s" },
    uplinks: ["ws://refusing"],
    storageProvider: new TestStorageProvider(),
    ownerAccountId: "rez:acct:m1b",
    sdk: fullSdk,
    inboxClaimant: makeInboxClaimant(),
    logger: QUIET_LOGGER,
  });
  await assert.rejects(app.start(), (err) => err.code === "DELEGATED_DEVICES_UNSUPPORTED");
});

// ---- The real thing: offline cold start heals over a real node + real pool ----

const CRYPTO = new NodeCryptoProvider();

class MemoryStorageProvider {
  #kv = new TestKVStore();
  getKeyValueStore() { return this.#kv; }
}

function accountIdentity() {
  const kp = CRYPTO.generateSigningKeyPair();
  return { publicKeyB64: bytesToBase64(kp.publicKey), privateKeyB64: bytesToBase64(kp.privateKey) };
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = addr && typeof addr === "object" ? addr.port : 0;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

test("M1 kill shot: claimant runtime boots with NO node running, then the node appears and the pool's own background reconnect completes claim + bind", async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "rez-m1-"));
  t.after(() => fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {}));
  const wsPort = await getFreePort();
  const wsUrl = "ws://127.0.0.1:" + wsPort + "/ws";

  const identity = accountIdentity();
  const claimant = await InboxClaimant.bootstrap({
    storageProvider: new MemoryStorageProvider(),
    cryptoProvider: CRYPTO,
    identity,
  });

  const bus = makeBus();
  const runtime = new ServerRuntimeService({
    bus,
    identity,
    uplinks: [wsUrl],
    inboxClaimant: claimant,
    wsFactory: (url) => new WebSocket(url),
    sessionMode: "claimant",
    logger: QUIET_LOGGER,
  });
  t.after(() => runtime.disconnect().catch(() => {}));

  // Cold start with the home DOWN: retryable, bind pending, nothing bound.
  await assert.rejects(runtime.connect(), (err) => err.retryable === true);
  assert.equal(runtime.connected, false);

  // The network appears (the node starts). No app-level retry is issued —
  // the pool's own scheduled reconnect must find it and complete the bind.
  const nodeApp = await startRezNode({
    node: {
      ws: { host: "127.0.0.1", port: wsPort, path: "/ws" },
      storage: { dataDir: path.join(tmpDir, "node-data") },
      network: { participateInRouting: true, knownRelays: [] },
      mesh: { enabled: true, mode: "seed-only", seeds: [], minPeers: 1, maxPeers: 5, policy: { defaultHops: 1, forceOnionRouting: false } },
      relay: { listenHost: "127.0.0.1", listenPort: 0 },
    },
  });
  t.after(() => nodeApp.stop().catch(() => {}));

  const deadline = Date.now() + 30_000;
  while (!runtime.connected && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.equal(runtime.connected, true, "the pool reconnect completed the first bind without a process restart");
  assert.ok(bus.events.some((e) => e.name === "runtime.connected"));
});
