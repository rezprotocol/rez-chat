import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { WebSocket } from "ws";
import { startRezNode, NodeCryptoProvider } from "@rezprotocol/node";
import {
  bytesToBase64,
  deriveAccountIdFromPublicKey,
  DeviceRegistrationV1,
  KeystoreStore,
} from "@rezprotocol/core";
import { unlockKeystoreAccount } from "@rezprotocol/sdk/client";
import { createKeyValueBackedPeerLinkStorage } from "@rezprotocol/sdk/peer-link";
import { SeedKeys } from "@rezprotocol/sdk/crypto/seedDerivation";
import { Bip39 } from "@rezprotocol/sdk/crypto/bip39";
import { bootstrapChatServer } from "../src/server/index.js";
import { enrollDelegatedDevice } from "../src/mobile/enrollDelegatedDevice.js";
import { activateDelegatedDevice } from "../src/mobile/activateDelegatedDevice.js";
import { prepareDelegatedCoreBoot } from "../src/mobile/prepareDelegatedCoreBoot.js";
import { startRezChatCore } from "../src/mobile/startRezChatCore.js";
import { MESH_FORM_WAIT_MS } from "./support/meshFormWait.js";
import { createTestRuntimeOwnership } from "./support/testRuntimeOwnership.js";

/**
 * LIVE local-mesh SPLIT-TRANSPORT ACTIVATION e2e — the P1.3b acceptance
 * (plans/MOBILE_PLATFORM_INTEGRATION_PLAN.md, frozen rulings 2026-08-26).
 *
 * The frozen transaction, over real transports end to end:
 *
 *   enroll (P1.3a) → bounded ACCOUNT session to the PG HOME (bootstrap inbox
 *   claimed exactly, device.bind, BOOTSTRAPPING, baseline drained) → READY →
 *   portable per-device inbox established at the PORTABLE PROVIDER (fresh
 *   claimant, close key, generation 1, standard lease, durably persisted) →
 *   bundle published carrying the PORTABLE inboxId → ACTIVE → the ACCOUNT
 *   session ends → steady state: startRezChatCore → CLAIMANT against the
 *   portable provider, zero ACCOUNT construction.
 *
 *   primary ─┬─ pgHome (backend=pg, fanout gate open) ── relay ── portableNode
 *   carol   ─┘        (bounded ACCOUNT session)                   (fs; the
 *   "phone" ──────────┴──────────────────────────────────────────  phone's
 *                                                                  CLAIMANT home)
 *
 * Pinned here (each traced to a ruling; the steady phase runs the REAL
 * host flow — unlock → prepareDelegatedCoreBoot (P1.3c) → startRezChatCore):
 *   1. HALFWAY STATE: after enrollment, BEFORE activation, the boot mapping
 *      REFUSES with ENROLLMENT_INCOMPLETE — the bootstrap inbox is
 *      never a fallback primary (R3).
 *   2. The activation verb reaches ACTIVE; portableInboxId ≠ bootstrapInboxId.
 *   3. The pg home's served bundle carries the PORTABLE inboxId — while the
 *      device.add registry row still names the BOOTSTRAP inbox (the two
 *      addresses are different objects, by design).
 *   4. A RERUN of the verb is idempotent: alreadyActive, same portable inbox.
 *   5. Steady state: claimant sessionMode, runtime inbox === portable
 *      primary, standard lease, ZERO AccountControlChannel executions, and
 *      the baseline APPLIED (carol's thread surfaces from replicated state
 *      the phone got through the bootstrap inbox during enrollment).
 *   6. BOOTSTRAP DORMANCY (R2): with the steady runtime's clock advanced
 *      past the renewal threshold, ordinary claimant wakes renew the
 *      PORTABLE lease — and the bootstrap lease stays byte-identical:
 *      nothing renews, re-claims, or publishes the bootstrap inbox after
 *      ACTIVE.
 *
 * Cross-provider MESSAGE delivery to the portable inbox is P1.3d's
 * acceptance (with the kill-mid-transaction variants); this file ends at the
 * split transport being real and the steady state being pure claimant.
 *
 * Gated behind RUN_LOCAL_MESH_E2E=1 AND REZ_PG_TEST_URL.
 */

const RUN = process.env.RUN_LOCAL_MESH_E2E === "1";
const PG_URL = process.env.REZ_PG_TEST_URL || "";
const SKIP = !(RUN && PG_URL);
const SCHEMA = "test_p13b_mobile_activation";
const CHAT_TIMEOUT_MS = 30_000;
const CRYPTO = new NodeCryptoProvider();

const silentLogger = { log() {}, info() {}, warn() {}, error() {}, debug() {} };

const SEED_LABEL_CHAT_SERVER = "rez/identity/chat-server/v1";
const SEED_LABEL_X3DH_DH = "rez/identity/x3dh-dh/v1";

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

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

const knownRelay = (relayKeyId, port) => ({
  id: relayKeyId, relayKeyId, host: "127.0.0.1", port, transport: "tcp", insecure: true, tls: false,
});

function relayOnlyConfig({ dataDir, listenPort, knownRelays }) {
  return {
    node: {
      mode: "relay-only",
      storage: { dataDir },
      network: { knownRelays },
      mesh: { mode: "seed-only", seeds: [] },
      relay: { listenHost: "127.0.0.1", listenPort, advertisedHost: "127.0.0.1" },
    },
  };
}

async function makePrimaryIdentity() {
  const mnemonic = Bip39.generateMnemonic({ words: 24 });
  const seed = await Bip39.mnemonicToSeed(mnemonic);
  const chatServerKeys = SeedKeys.deriveEd25519({ seed, label: SEED_LABEL_CHAT_SERVER });
  const dh = SeedKeys.deriveX25519({ seed, label: SEED_LABEL_X3DH_DH });
  seed.fill(0);
  const c = CRYPTO.generateSigningKeyPair();
  const publicKeyBytes = Uint8Array.from(Buffer.from(chatServerKeys.publicKeyB64, "base64"));
  return {
    accountId: deriveAccountIdFromPublicKey(publicKeyBytes),
    chatServerIdentity: {
      accountId: deriveAccountIdFromPublicKey(publicKeyBytes),
      publicKeyB64: chatServerKeys.publicKeyB64,
      privateKeyB64: chatServerKeys.privateKeyB64,
      accountIdentityDhKeyPair: { publicKeyB64: dh.publicKeyB64, privateKeyB64: dh.privateKeyB64 },
    },
    deviceKey: {
      deviceId: DeviceRegistrationV1.deviceIdFor(bytesToBase64(c.publicKey)),
      deviceKeyPair: { publicKeyB64: bytesToBase64(c.publicKey), privateKeyB64: bytesToBase64(c.privateKey) },
    },
  };
}

function schemaScopedUrl(url, schema) {
  const sep = url.includes("?") ? "&" : "?";
  return url + sep + "options=" + encodeURIComponent("-c search_path=" + schema);
}

async function withAdminPg(url, fn) {
  const pg = await import("pg");
  const Pool = pg.default ? pg.default.Pool : pg.Pool;
  const pool = new Pool({ connectionString: url });
  try { return await fn(pool); } finally { await pool.end(); }
}

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try { const value = await fn(); if (value) return value; } catch (err) { lastError = err; }
    await sleep(400);
  }
  throw new Error("Timed out waiting for " + label + (lastError && lastError.message ? ": " + lastError.message : ""));
}

// The phone host's providers: a durable-across-kills KV storage (SQLite on a
// device; a Map here) + the sdk's KV-backed peer-link storage composition.
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
class HostStorageProvider {
  constructor() {
    this._stores = new Map();
    this._peerLinkStorage = createKeyValueBackedPeerLinkStorage({ keyValueStore: this.getKeyValueStore(null) });
    this._acquireRuntimeOwnership = createTestRuntimeOwnership();
  }
  getKeyValueStore(name) {
    const key = name == null ? "" : String(name);
    if (!this._stores.has(key)) this._stores.set(key, new TestKVStore());
    return this._stores.get(key);
  }
  getPeerLinkStorage() { return this._peerLinkStorage; }
  acquireRuntimeOwnership(options) { return this._acquireRuntimeOwnership(options); }
}

function memoryStorageProvider() {
  const map = new Map();
  return {
    get(key) { return map.has(key) ? map.get(key) : null; },
    put(key, value) { map.set(key, value); },
    del(key) { map.delete(key); },
  };
}

async function waitForDirectThread(chat, peerAccountId, label) {
  const thread = await waitFor(async () => {
    const result = await chat.bus.call("threads", "list", { limit: 50 });
    const threads = result && Array.isArray(result.threads) ? result.threads : [];
    return threads.find((item) => item && typeof item === "object"
      && String(item.peerAccountId || "").trim() === peerAccountId
      && item.threadId);
  }, CHAT_TIMEOUT_MS, label);
  return thread.threadId;
}

test("P1.3b acceptance: enroll → bounded ACCOUNT activation (portable inbox established, bundle carries it) → steady-state pure CLAIMANT on the portable provider; bootstrap dormant", { skip: SKIP ? "set RUN_LOCAL_MESH_E2E=1 and REZ_PG_TEST_URL to run" : false, timeout: 300_000 }, async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "rez-p13b-activation-"));
  const rPort = await getFreePort();
  const homeWsPort = await getFreePort();
  const portableWsPort = await getFreePort();
  const homeWsUrl = "ws://127.0.0.1:" + homeWsPort + "/ws";
  const portableWsUrl = "ws://127.0.0.1:" + portableWsPort + "/ws";
  const schemaUrl = schemaScopedUrl(PG_URL, SCHEMA);
  const started = [];
  const chats = [];
  let steadyCore = null;

  await withAdminPg(PG_URL, async (pool) => {
    await pool.query("DROP SCHEMA IF EXISTS " + SCHEMA + " CASCADE");
    await pool.query("CREATE SCHEMA " + SCHEMA);
  });

  try {
    const relayApp = await startRezNode(relayOnlyConfig({
      dataDir: path.join(tmp, "relay"), listenPort: rPort, knownRelays: [],
    }));
    started.push(relayApp);
    const relayKeyId = relayApp.runtime.getIdentity().relayKeyId;

    // The pg ACCOUNT home (bounded enrollment sessions only, for the phone).
    const home = await startRezNode({
      node: {
        ws: { host: "127.0.0.1", port: homeWsPort, path: "/ws" },
        storage: {
          dataDir: path.join(tmp, "home-node"),
          backend: "pg",
          encryptionKeyB64: bytesToBase64(CRYPTO.randomBytes(32)),
          pg: { connectionString: schemaUrl, migrateOnBoot: true },
        },
        network: { participateInRouting: true, knownRelays: [knownRelay(relayKeyId, rPort)] },
        mesh: { enabled: true, mode: "seed-only", seeds: [], minPeers: 1, maxPeers: 5 },
        relay: { listenHost: "127.0.0.1", listenPort: 0 },
        device: { multiDeviceFanout: true },
      },
    });
    started.push(home);

    // The PORTABLE provider: an fs node — exactly the shape the P1.1 mobile
    // core boots against; it accepts standard-retention claimant leases.
    const portableNode = await startRezNode({
      node: {
        ws: { host: "127.0.0.1", port: portableWsPort, path: "/ws" },
        storage: { dataDir: path.join(tmp, "portable-node") },
        network: { participateInRouting: true, knownRelays: [knownRelay(relayKeyId, rPort)] },
        mesh: { enabled: true, mode: "seed-only", seeds: [], minPeers: 1, maxPeers: 5 },
        relay: { listenHost: "127.0.0.1", listenPort: 0 },
      },
    });
    started.push(portableNode);

    const primaryId = await makePrimaryIdentity();
    const carolId = await makePrimaryIdentity();
    await sleep(MESH_FORM_WAIT_MS);

    const primary = await bootstrapChatServer({
      nodeDataDir: path.join(tmp, "primary"), wsUrl: homeWsUrl, logger: silentLogger,
      expectedChatServerIdentity: primaryId.chatServerIdentity, deviceKey: primaryId.deviceKey,
    });
    await primary.chatServer.start();
    chats.push(primary.chatServer);
    const carol = await bootstrapChatServer({
      nodeDataDir: path.join(tmp, "carol"), wsUrl: homeWsUrl, logger: silentLogger,
      expectedChatServerIdentity: carolId.chatServerIdentity, deviceKey: carolId.deviceKey,
    });
    await carol.chatServer.start();
    chats.push(carol.chatServer);

    // carol becomes a REAL contact before the ceremony — baseline substance.
    const invite = await primary.chatServer.bus.call("invite", "create", {
      kind: "direct", maxUses: 1, creatorDisplayName: "Primary",
    });
    await carol.chatServer.bus.call("invite", "accept", {
      inviteCode: invite.inviteCode, acceptorDisplayName: "Carol",
    });
    await waitForDirectThread(primary.chatServer, carol.ownerAccountId, "primary thread to carol");

    // --- Enrollment (P1.3a, real ceremony) ---
    const events = [];
    primary.chatServer.bus.on("deviceLink.updated", (r) => {
      events.push(r && typeof r.toJSON === "function" ? r.toJSON() : r);
    });
    const ceremony = await primary.chatServer.bus.call("deviceLink", "start", {});
    const phoneKeystore = new KeystoreStore({ storageProvider: memoryStorageProvider() });
    const enrollPromise = enrollDelegatedDevice({
      linkCode: ceremony.linkCode,
      password: "phone-unlock-secret",
      profileName: "Phone",
      cryptoProvider: CRYPTO,
      wsFactory: (url) => new WebSocket(url),
      uplinks: [homeWsUrl],
      keystoreStore: phoneKeystore,
      timeoutMs: 60_000,
      logger: silentLogger,
    });
    const pending = await waitFor(async () => events.find((e) => e.state === "pending"), CHAT_TIMEOUT_MS, "device-link pending event");
    await primary.chatServer.bus.call("deviceLink", "approve", { newDeviceId: pending.newDeviceId });
    const enrolled = await enrollPromise;

    // The phone's runtime storage — durable across "process kills" below.
    const phoneStorage = new HostStorageProvider();
    const unlocked = await unlockKeystoreAccount({ password: "phone-unlock-secret", keystoreStore: phoneKeystore });
    const phoneIdentity = {
      accountId: unlocked.accountId,
      publicKeyB64: unlocked.identityPublicKey,
      hasAdminRoot: false,
      certChain: unlocked.certChain,
      accountIdentityDhKeyPair: unlocked.accountIdentityDhKeyPair,
      bootstrapInboxId: unlocked.bootstrapInboxId,
    };
    const phoneDeviceKey = { deviceId: unlocked.deviceId, deviceKeyPair: unlocked.deviceKeyPair };
    assert.equal(unlocked.bootstrapInboxId, enrolled.bootstrapInboxId);

    // PIN 1 — the HALFWAY STATE refuses: enrollment done, activation not run.
    // The steady-state flow (P1.3c mapping) must say "resume activation",
    // never claim the bootstrap inbox as its primary (the frozen no-fallback
    // rule). The mapper is the composed flow a real host runs; the boot-time
    // portable role enforces the same refusal independently (unit-pinned).
    let halfwayErr = null;
    try {
      await prepareDelegatedCoreBoot({
        unlocked,
        storageProvider: phoneStorage,
        cryptoProvider: CRYPTO,
        uplinks: [portableWsUrl],
        wsFactory: (url) => new WebSocket(url),
        logger: silentLogger,
      });
    } catch (err) {
      halfwayErr = err;
    }
    assert.ok(halfwayErr, "the halfway state must refuse to boot");
    assert.equal(halfwayErr.code, "ENROLLMENT_INCOMPLETE");

    // --- The bounded ACCOUNT activation session (P1.3b) ---
    const activated = await activateDelegatedDevice({
      identity: phoneIdentity,
      deviceKey: phoneDeviceKey,
      storageProvider: phoneStorage,
      cryptoProvider: CRYPTO,
      accountHomeUplinks: [homeWsUrl],
      portableUplinks: [portableWsUrl],
      wsFactory: (url) => new WebSocket(url),
      timeoutMs: 120_000,
      logger: silentLogger,
    });

    // PIN 2 — ACTIVE, and the two addresses are DIFFERENT objects.
    assert.equal(activated.state, "ACTIVE");
    assert.equal(activated.alreadyActive, false);
    assert.equal(activated.deviceId, enrolled.deviceId);
    assert.match(activated.portableInboxId, /^inbox:[0-9a-f]{24}$/);
    assert.notEqual(activated.portableInboxId, enrolled.bootstrapInboxId,
      "the published address is the portable inbox, not the enrollment route");

    // PIN 3 — the pg home SERVES a bundle carrying the PORTABLE inboxId,
    // while the device.add registry row still names the BOOTSTRAP inbox.
    const bundleRow = await withAdminPg(schemaUrl, async (pool) => {
      const r = await pool.query("SELECT bundle_json FROM account_device_bundle WHERE device_id = $1", [enrolled.deviceId]);
      return r.rows[0] ? r.rows[0].bundle_json : null;
    });
    assert.ok(bundleRow, "the READY→ACTIVE commit published the bundle");
    const bundle = typeof bundleRow === "string" ? JSON.parse(bundleRow) : bundleRow;
    assert.equal(bundle.inboxId, activated.portableInboxId, "the world learns the PORTABLE address");
    const registryRow = await withAdminPg(schemaUrl, async (pool) => {
      const r = await pool.query("SELECT inbox_id FROM account_device_registry WHERE device_id = $1", [enrolled.deviceId]);
      return r.rows[0] ? r.rows[0] : null;
    });
    assert.equal(registryRow.inbox_id, enrolled.bootstrapInboxId,
      "the registry's immutable device.add bookkeeping still names the bootstrap inbox — routing truth is the bundle");

    // PIN 4 — rerunning the verb is idempotent and stays on the same address.
    const rerun = await activateDelegatedDevice({
      identity: phoneIdentity,
      deviceKey: phoneDeviceKey,
      storageProvider: phoneStorage,
      cryptoProvider: CRYPTO,
      accountHomeUplinks: [homeWsUrl],
      portableUplinks: [portableWsUrl],
      wsFactory: (url) => new WebSocket(url),
      logger: silentLogger,
    });
    assert.equal(rerun.alreadyActive, true);
    assert.equal(rerun.portableInboxId, activated.portableInboxId);

    // --- Steady state: "kill" the phone, boot the ordinary claimant core
    // against the PORTABLE provider over the same storage. ---
    let clockOffsetMs = 0;
    // The REAL host flow (P1.3c): unlock → prepareDelegatedCoreBoot →
    // startRezChatCore — the mapper produces the boot inputs verbatim.
    const bootInputs = await prepareDelegatedCoreBoot({
      unlocked,
      storageProvider: phoneStorage,
      cryptoProvider: CRYPTO,
      uplinks: [portableWsUrl],
      wsFactory: (url) => new WebSocket(url),
      clock: () => Date.now() + clockOffsetMs,
      logger: silentLogger,
    });
    assert.equal(bootInputs.identity.inboxId, unlocked.bootstrapInboxId,
      "the mapping carries bootstrapInboxId as enrollment metadata");
    steadyCore = await startRezChatCore(bootInputs);
    await steadyCore.chatServer.start();

    // PIN 5 — pure claimant on the portable address, zero ACCOUNT anything.
    assert.equal(steadyCore.chatServer.bus.runtime.sessionMode, "claimant");
    assert.equal(steadyCore.inboxClaimant.inboxId, activated.portableInboxId,
      "the runtime inbox IS the claim store's portable primary");
    assert.notEqual(steadyCore.inboxClaimant.inboxId, enrolled.bootstrapInboxId);
    const portableLease = steadyCore.inboxClaimant.claimStore.leaseState(activated.portableInboxId);
    assert.ok(portableLease, "the portable lease is recorded");
    assert.equal(portableLease.retentionClass, "standard");
    assert.equal(steadyCore.chatServer.bus.runtime.accountControl.executeCount, 0,
      "zero account executions on the whole steady-state path");
    assert.equal(steadyCore.chatServer.bus.runtime.accountControl.active, false);
    // The baseline APPLIED: carol's thread surfaces from state replicated
    // through the bootstrap inbox during enrollment — the phone never took
    // part in any invite.
    await waitForDirectThread(steadyCore.chatServer, carol.ownerAccountId, "the phone holds carol's thread from the baseline");

    // PIN 6 — BOOTSTRAP DORMANCY (R2). Snapshot the bootstrap lease the
    // enrollment session recorded, advance the claimant runtime's clock past
    // the portable renewal threshold, and run ordinary wakes: the PORTABLE
    // lease renews; the bootstrap lease stays byte-identical. "After ACTIVE,
    // the bootstrap inbox must never be renewed."
    const claimStore = steadyCore.inboxClaimant.claimStore;
    const bootstrapLeaseBefore = claimStore.leaseState(enrolled.bootstrapInboxId);
    assert.ok(bootstrapLeaseBefore, "the enrollment session recorded the bootstrap lease it was granted");
    const portableLeaseBefore = claimStore.leaseState(activated.portableInboxId);
    const ttlMs = Number(portableLeaseBefore.expiresAtMs) - Number(portableLeaseBefore.issuedAtMs);
    clockOffsetMs = Math.floor(ttlMs / 2) + 60_000; // past TTL/2 → renewal due
    const report = await steadyCore.adapter.onForeground();
    assert.equal(report.live, true);
    assert.equal(report.steps.renewLeaseIfDue.ok, true, JSON.stringify(report.steps.renewLeaseIfDue));
    const portableLeaseAfter = claimStore.leaseState(activated.portableInboxId);
    assert.ok(Number(portableLeaseAfter.issuedAtMs) > Number(portableLeaseBefore.issuedAtMs),
      "the ordinary wake RENEWED the portable lease (the threshold was crossed)");
    const bootstrapLeaseAfter = claimStore.leaseState(enrolled.bootstrapInboxId);
    assert.deepEqual(bootstrapLeaseAfter, bootstrapLeaseBefore,
      "the bootstrap lease is untouched — dormant means dormant, until the provider expires it");
  } finally {
    if (steadyCore) {
      await steadyCore.chatServer.stop().catch((err) => {
        console.error("[p13b e2e] steady core stop failed", err && err.message ? err.message : err);
      });
    }
    for (const chat of chats.reverse()) {
      if (chat && typeof chat.stop === "function") await chat.stop().catch(() => {});
    }
    for (const app of started.reverse()) {
      if (app && typeof app.stop === "function") await app.stop().catch(() => {});
    }
    await withAdminPg(PG_URL, async (pool) => {
      await pool.query("DROP SCHEMA IF EXISTS " + SCHEMA + " CASCADE");
    }).catch((err) => {
      console.error("[p13b e2e] schema teardown failed", err && err.message ? err.message : err);
    });
    await fs.rm(tmp, { recursive: true, force: true }).catch((err) => {
      console.error("[p13b e2e] tmp cleanup failed", err && err.message ? err.message : err);
    });
  }
});
