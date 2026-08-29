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
import { SeedKeys } from "@rezprotocol/sdk/crypto/seedDerivation";
import { Bip39 } from "@rezprotocol/sdk/crypto/bip39";
import { bootstrapChatServer } from "../src/server/index.js";
import { enrollDelegatedDevice } from "../src/mobile/enrollDelegatedDevice.js";
import { MESH_FORM_WAIT_MS } from "./support/meshFormWait.js";

/**
 * LIVE local-mesh MOBILE ENROLLMENT e2e — the P1.3a acceptance
 * (plans/P1_3_ENROLLMENT_TRACE.md §8): `enrollDelegatedDevice`, the
 * runtime-neutral entry point, runs the REAL requester ceremony against a
 * REAL linking-capable pg home, with every host dependency injected the way
 * a phone would inject it (NodeCrypto as the platform RCryptoProvider, `ws`
 * as the platform WebSocket, an in-memory KV KeystoreStore as host custody).
 *
 *   primary ── pgHome (backend=pg) ── relay
 *   "phone" ──┘   (enrollDelegatedDevice only — never boots a runtime)
 *
 * P1.3a's frozen scope ends at the sealed envelope: parse code → ceremony →
 * delegation verified → envelope DURABLY persisted → confirm → identity
 * facts returned. No runtime boot, no activation, no portable inbox — the
 * activation transaction this envelope feeds is pinned separately by
 * e2e.local-mesh.pg.device-activation.test.js (P1.3-pre), and the bounded
 * enrollment session is P1.3b.
 *
 * What this file proves that the unit suite cannot: the ceremony knowledge
 * chain over real transports — the envelope's persisted inboxId is EXACTLY
 * the inbox the home's device.add committed (account_device_registry), the
 * address the activation baseline will later be requested at.
 *
 * Gated behind RUN_LOCAL_MESH_E2E=1 AND REZ_PG_TEST_URL.
 */

const RUN = process.env.RUN_LOCAL_MESH_E2E === "1";
const PG_URL = process.env.REZ_PG_TEST_URL || "";
const SKIP = !(RUN && PG_URL);
const SCHEMA = "test_p13a_mobile_enroll";
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

// The host-custody seam a phone provides: a generic KV store (P1.1 frozen —
// the host KV is generic; Rez owns record semantics).
function memoryStorageProvider() {
  const map = new Map();
  return {
    get(key) { return map.has(key) ? map.get(key) : null; },
    put(key, value) { map.set(key, value); },
    del(key) { map.delete(key); },
  };
}

test("P1.3a acceptance: enrollDelegatedDevice runs the real ceremony against a real pg home and leaves the sealed envelope carrying EXACTLY the device.add-committed bootstrap inbox", { skip: SKIP ? "set RUN_LOCAL_MESH_E2E=1 and REZ_PG_TEST_URL to run" : false, timeout: 180_000 }, async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "rez-p13a-mobile-enroll-"));
  const rPort = await getFreePort();
  const homeWsPort = await getFreePort();
  const homeWsUrl = "ws://127.0.0.1:" + homeWsPort + "/ws";
  const schemaUrl = schemaScopedUrl(PG_URL, SCHEMA);
  const started = [];
  const chats = [];

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

    const primaryId = await makePrimaryIdentity();
    await sleep(MESH_FORM_WAIT_MS);

    const primary = await bootstrapChatServer({
      nodeDataDir: path.join(tmp, "primary"), wsUrl: homeWsUrl, logger: silentLogger,
      expectedChatServerIdentity: primaryId.chatServerIdentity, deviceKey: primaryId.deviceKey,
    });
    await primary.chatServer.start();
    chats.push(primary.chatServer);

    const events = [];
    primary.chatServer.bus.on("deviceLink.updated", (r) => {
      events.push(r && typeof r.toJSON === "function" ? r.toJSON() : r);
    });
    const ceremony = await primary.chatServer.bus.call("deviceLink", "start", {});
    assert.match(ceremony.linkCode, /^rez:link:v1:/);

    // The "phone": every dependency injected through the runtime-neutral
    // entry point exactly as a host would inject it. Host custody is a plain
    // KV-backed KeystoreStore that starts EMPTY.
    const phoneStore = new KeystoreStore({ storageProvider: memoryStorageProvider() });
    const statuses = [];
    const enrollPromise = enrollDelegatedDevice({
      linkCode: ceremony.linkCode,
      password: "phone-unlock-secret",
      profileName: "Phone",
      cryptoProvider: CRYPTO,
      wsFactory: (url) => new WebSocket(url),
      uplinks: [homeWsUrl],
      keystoreStore: phoneStore,
      clock: () => Date.now(),
      timeoutMs: 60_000,
      onStatus: (s) => statuses.push(s),
      logger: silentLogger,
    });

    const pending = await waitFor(async () => events.find((e) => e.state === "pending"), CHAT_TIMEOUT_MS, "device-link pending event");
    await primary.chatServer.bus.call("deviceLink", "approve", { newDeviceId: pending.newDeviceId });
    const enrolled = await enrollPromise;
    await waitFor(async () => events.find((e) => e.state === "confirmed"), CHAT_TIMEOUT_MS, "device-link confirmed event");

    // The return is identity facts ONLY — never key material.
    assert.deepEqual(Object.keys(enrolled).sort(), ["accountId", "bootstrapInboxId", "deviceId"]);
    assert.equal(enrolled.accountId, primary.ownerAccountId, "the delegated envelope anchors at the primary's account");
    assert.equal(enrolled.deviceId, pending.newDeviceId, "the enrolled device IS the approved device");
    assert.match(enrolled.bootstrapInboxId, /^inbox:[0-9a-f]{24}$/);
    assert.deepEqual(
      statuses,
      ["publishing-request", "waiting-approval", "validating", "persisting", "confirming"],
      "the host observed the full ceremony phase sequence, persistence strictly before confirmation",
    );

    // Ceremony knowledge chain, over real transports: the home's device.add
    // committed EXACTLY the inbox the sealed envelope carries — the address
    // the activation baseline will later be requested at (P1.3-pre), with no
    // DeviceSet discovery anywhere.
    const row = await withAdminPg(schemaUrl, async (pool) => {
      const r = await pool.query(
        "SELECT inbox_id, status FROM account_device_registry WHERE device_id = $1",
        [enrolled.deviceId],
      );
      return r.rows[0] ? r.rows[0] : null;
    });
    assert.ok(row, "device.add committed a registry row for the enrolled device");
    assert.equal(row.status, "active");
    assert.equal(row.inbox_id, enrolled.bootstrapInboxId, "the registered inbox IS the envelope's bootstrap inbox");

    // Host custody holds the ONLY copy of C, sealed: the envelope unlocks to
    // a delegated identity (no admin root), with the ceremony's device key
    // and bootstrap inbox.
    const unlocked = await unlockKeystoreAccount({
      password: "phone-unlock-secret",
      keystoreStore: phoneStore,
    });
    assert.equal(unlocked.hasAdminRoot, false);
    assert.equal(unlocked.identityKeyPair, null, "no account signing key exists on the phone");
    assert.equal(unlocked.accountId, enrolled.accountId);
    assert.equal(unlocked.deviceId, enrolled.deviceId);
    assert.equal(unlocked.bootstrapInboxId, enrolled.bootstrapInboxId);
    assert.ok(unlocked.deviceKeyPair && unlocked.deviceKeyPair.privateKeyB64, "the envelope holds C — the key never rode the wire");
  } finally {
    for (const chat of chats.reverse()) {
      if (chat && typeof chat.stop === "function") await chat.stop().catch(() => {});
    }
    for (const app of started.reverse()) {
      if (app && typeof app.stop === "function") await app.stop().catch(() => {});
    }
    await withAdminPg(PG_URL, async (pool) => {
      await pool.query("DROP SCHEMA IF EXISTS " + SCHEMA + " CASCADE");
    }).catch((err) => {
      console.error("[p13a mobile-enroll e2e] schema teardown failed", err && err.message ? err.message : err);
    });
    await fs.rm(tmp, { recursive: true, force: true }).catch((err) => {
      console.error("[p13a mobile-enroll e2e] tmp cleanup failed", err && err.message ? err.message : err);
    });
  }
});
