// P1.1 acceptance (plans/MOBILE_PLATFORM_INTEGRATION_PLAN.md) — the headless
// claimant core boot, end to end. The HOST role is played by this test file:
// it supplies the providers a Swift/Kotlin/Tauri shell would (storage,
// crypto, the platform WebSocket, identity from its keystore) and calls
// lifecycle hooks. The CORE under test is startRezChatCore — which the
// boundary suite proves can never reach node builtins, a local rez-node,
// the ws package, or the desktop tree. The REMOTE provider is a real
// rez-node reached only over its wsUrl, exactly like a phone would.
//
// The frozen acceptance shape (program plan §7 / P1.1 ruling):
//   headless boot online   → claimant ready, no local node, no UI, converge
//   headless boot offline  → services start disconnected → network later →
//                            heals without restart
//   process kill           → second boot over the same provider-backed
//                            storage reconstructs; no correctness state in
//                            host memory
//   ordinary boot/wake     → zero AccountControlChannel executions

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { bytesToBase64, deriveAccountIdFromPublicKey } from "@rezprotocol/core";
import { NodeCryptoProvider, startRezNode } from "@rezprotocol/node";

import { createKeyValueBackedPeerLinkStorage } from "@rezprotocol/sdk/peer-link";

import { startRezChatCore } from "../src/mobile/startRezChatCore.js";

const CRYPTO = new NodeCryptoProvider();
const QUIET = { log() {}, warn() {}, info() {}, error() {} };

class TestKVStore {
  constructor() { this._data = new Map(); }
  async get(key) { return this._data.has(key) ? this._data.get(key) : null; }
  async set(key, value) { this._data.set(key, JSON.parse(JSON.stringify(value))); }
  async delete(key) { this._data.delete(key); }
  async keys(prefix) {
    const out = [];
    for (const k of this._data.keys()) if (k.startsWith(prefix)) out.push(k);
    return out;
  }
}
// The host's storage provider — durable across simulated process kills
// (the same instance handed to a second boot, the way a device's SQLite
// file survives its process).
class HostStorageProvider {
  constructor() {
    this._stores = new Map();
    // The provider contract the core needs is getKeyValueStore +
    // getPeerLinkStorage; the sdk supplies the KV-backed peer-link storage
    // composition, so a host only ever implements a KV store (SQLite on
    // device, this map here).
    this._peerLinkStorage = createKeyValueBackedPeerLinkStorage({ keyValueStore: this.getKeyValueStore(null) });
  }
  getKeyValueStore(name) {
    const key = name == null ? "" : String(name);
    if (!this._stores.has(key)) this._stores.set(key, new TestKVStore());
    return this._stores.get(key);
  }
  getPeerLinkStorage() { return this._peerLinkStorage; }
}

function hostIdentity() {
  const kp = CRYPTO.generateSigningKeyPair();
  const publicKeyB64 = bytesToBase64(kp.publicKey);
  return {
    accountId: deriveAccountIdFromPublicKey(kp.publicKey),
    deviceId: "dev:host-keystore",
    publicKeyB64,
    privateKeyB64: bytesToBase64(kp.privateKey),
  };
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

async function startRemoteProvider(t, wsPort) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "rez-p11-"));
  t.after(() => fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {}));
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
  return nodeApp;
}

async function bootCore({ identity, storage, wsUrl }) {
  return startRezChatCore({
    identity,
    storageProvider: storage,
    cryptoProvider: CRYPTO,
    uplinks: [wsUrl],
    wsFactory: (url) => new WebSocket(url),
    logger: QUIET,
  });
}

test("P1.1: headless boot ONLINE — claimant runtime ready against a remote provider; standard lease recorded; converge works; zero account executions", async (t) => {
  const wsPort = await getFreePort();
  await startRemoteProvider(t, wsPort);
  const identity = hostIdentity();
  const storage = new HostStorageProvider();

  const core = await bootCore({ identity, storage, wsUrl: "ws://127.0.0.1:" + wsPort + "/ws" });
  t.after(() => core.chatServer.stop().catch(() => {}));
  await core.chatServer.start();

  assert.equal(core.chatServer.bus.runtime.sessionMode, "claimant", "claimant by default at the mobile seam");
  assert.equal(core.chatServer.bus.services.runtime.connected, true);

  // The standard retention class flowed through the claim and the ACCEPTED
  // lease was recorded durably (M3) — the phone's mailbox runs the
  // lease/grace/reclaim lifecycle, not the desktop-transient one.
  const lease = core.inboxClaimant.claimStore.leaseState(core.inboxClaimant.inboxId);
  assert.ok(lease, "accepted lease persisted");
  assert.equal(lease.retentionClass, "standard");

  // A wake converges cleanly over the real provider.
  const report = await core.adapter.onForeground();
  assert.equal(report.live, true);
  for (const [label, step] of Object.entries(report.steps)) {
    assert.equal(step.ok, true, label + ": " + JSON.stringify(step));
  }

  // The kill assertions: no account authority, anywhere, on the whole path.
  assert.equal(core.chatServer.bus.runtime.accountControl.executeCount, 0);
  assert.equal(core.chatServer.bus.runtime.accountControl.active, false);
});

test("P1.1: headless boot OFFLINE — services start disconnected; the provider appears later; onNetworkAvailable heals without restart", async (t) => {
  const wsPort = await getFreePort(); // nothing listening yet
  const identity = hostIdentity();
  const storage = new HostStorageProvider();

  const core = await bootCore({ identity, storage, wsUrl: "ws://127.0.0.1:" + wsPort + "/ws" });
  t.after(() => core.chatServer.stop().catch(() => {}));
  await core.chatServer.start(); // M1: boots, all services up, disconnected
  assert.equal(core.chatServer.bus.services.runtime.connected, false);

  // A wake while still offline short-circuits and throws nothing at the host.
  const offlineReport = await core.adapter.onPeriodicWake();
  assert.equal(offlineReport.live, false);

  // The provider comes up; the host signals the network; the core heals.
  await startRemoteProvider(t, wsPort);
  const deadline = Date.now() + 30_000;
  let report = null;
  while (Date.now() < deadline) {
    report = await core.adapter.onNetworkAvailable();
    if (report.live) break;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  assert.equal(report.live, true, "the wake healed the boot — no process restart");
  assert.equal(core.chatServer.bus.services.runtime.connected, true);
  assert.equal(core.chatServer.bus.runtime.accountControl.executeCount, 0);
});

test("P1.1: process KILL — a second boot over the SAME host storage reconstructs the claim, address, and lease; nothing correctness-bearing lived in host memory", async (t) => {
  const wsPort = await getFreePort();
  await startRemoteProvider(t, wsPort);
  const identity = hostIdentity();
  const storage = new HostStorageProvider();
  const wsUrl = "ws://127.0.0.1:" + wsPort + "/ws";

  // Life 1: boot, bind, converge — then KILL (no stop(); a killed process
  // says no goodbyes; only the provider-backed storage survives).
  const life1 = await bootCore({ identity, storage, wsUrl });
  await life1.chatServer.start();
  await life1.adapter.onForeground();
  const inboxId = life1.inboxClaimant.inboxId;
  assert.ok(life1.inboxClaimant.claimStore.leaseState(inboxId));

  // Life 2: a fresh core over the same storage. The durable claim (the
  // ADDRESS), the claimant key, and the lease all reconstruct.
  const life2 = await bootCore({ identity, storage, wsUrl });
  t.after(() => life2.chatServer.stop().catch(() => {}));
  await life2.chatServer.start();
  assert.equal(life2.inboxClaimant.inboxId, inboxId, "the portable address survived the kill");
  const report = await life2.adapter.onForeground();
  assert.equal(report.live, true);
  const lease = life2.inboxClaimant.claimStore.leaseState(inboxId);
  assert.equal(lease.retentionClass, "standard");
  assert.equal(life2.chatServer.bus.runtime.accountControl.executeCount, 0);
});
