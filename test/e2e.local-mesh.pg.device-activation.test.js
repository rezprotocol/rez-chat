import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { startRezNode, NodeCryptoProvider } from "@rezprotocol/node";
import {
  bytesToBase64,
  deriveAccountIdFromPublicKey,
  DeviceRegistrationV1,
} from "@rezprotocol/core";
import { SeedKeys } from "@rezprotocol/sdk/crypto/seedDerivation";
import { Bip39 } from "@rezprotocol/sdk/crypto/bip39";
import { bootstrapChatServer } from "../src/server/index.js";
import { DesktopVaultService } from "../src/desktop/runtime/DesktopVaultService.js";
import { runDeviceLinkRequester } from "../src/desktop/runtime/DesktopDeviceLinkRunner.js";
import { MESH_FORM_WAIT_MS } from "./support/meshFormWait.js";

/**
 * LIVE local-mesh + REAL pg DEVICE-ACTIVATION e2e — the P1.3-pre pin
 * (plans/P1_3_ENROLLMENT_TRACE.md §11, frozen R1 ruling 2026-08-26).
 *
 * THE FROZEN INVARIANT UNDER TEST:
 *
 *   After device.add commits and the requester confirms, the approver sends
 *   the activation baseline DIRECTLY to the new device's ceremony/bootstrap
 *   inbox. It does NOT discover that destination through DeviceSet.
 *
 * Why this file exists: the shipped wiring resolved baseline targets from the
 * bundle-derived sibling list — but a BOOTSTRAPPING device defers bundle
 * publication until its READY→ACTIVE commit, so the ONE device the baseline
 * exists for was structurally absent from the very list used to reach it
 * (fannedOut: 0 returned as success). The unit harness hid it with a mocked
 * sibling list, and the S13 fanout e2e boots both devices with the PRIMARY
 * key, which skips the activation gate entirely. This test closes both
 * holes at once, per the R1 ruling:
 *
 *   real delegated C identity  — vault-provisioned from the real ceremony
 *   real PG home               — device.multiDeviceFanout gate OPEN
 *   no primary/root key        — the delegated leaf's #hasAccountKey is false,
 *                                so the activation gate actually engages
 *   no mocked sibling list     — every hop rides real transports
 *
 *   confirm → baseline reaches bootstrap inbox → READY → bundle publication
 *   → ACTIVE
 *
 * Delivery timing, learned on this real transport: a durable home accepts
 * deposits only for CLAIMED inboxes, and the ceremony inbox is first claimed
 * at the delegated device's first connect — so the approver's confirm-instant
 * push cannot land pre-boot. The deterministic delivery is the device's own
 * baseline request on entering BOOTSTRAPPING, answered by the approver
 * DIRECTLY at the inbox the signed request names. Both halves obey the
 * frozen invariant: neither ever consults DeviceSet for the destination.
 *
 * Topology (one hosted pg home, the only topology where linking exists):
 *
 *   primary ─┐
 *   newdev  ─┼─ pgHome (backend=pg, device.multiDeviceFanout=true) ── relay
 *   carol   ─┘
 *
 * carol is a real active contact of the primary BEFORE the ceremony, so the
 * baseline carries substantive state (contact.upsert + marker) and the
 * delegated device proves the baseline APPLIED — not merely arrived — by
 * surfacing carol's thread before it ever talks to anyone.
 *
 * Gated behind RUN_LOCAL_MESH_E2E=1 AND REZ_PG_TEST_URL.
 */

const RUN = process.env.RUN_LOCAL_MESH_E2E === "1";
const PG_URL = process.env.REZ_PG_TEST_URL || "";
const SKIP = !(RUN && PG_URL);
const SCHEMA = "test_p13pre_device_activation";
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

// `pg` is imported dynamically so this file still LOADS (and skips) on a run
// with no REZ_PG_TEST_URL; everything below is unreachable when SKIP is true.
async function withAdminPg(url, fn) {
  const pg = await import("pg");
  const Pool = pg.default ? pg.default.Pool : pg.Pool;
  const pool = new Pool({ connectionString: url });
  try { return await fn(pool); } finally { await pool.end(); }
}

async function bundleRowCount(schemaUrl, deviceId) {
  return withAdminPg(schemaUrl, async (pool) => {
    const r = await pool.query("SELECT count(*)::int AS n FROM account_device_bundle WHERE device_id = $1", [deviceId]);
    return r.rows[0] ? r.rows[0].n : 0;
  });
}

async function bootChatLeaf({ dataDir, wsUrl, expectedChatServerIdentity, deviceKey }) {
  const bootstrapped = await bootstrapChatServer({
    nodeDataDir: dataDir, wsUrl, logger: silentLogger, expectedChatServerIdentity, deviceKey,
  });
  await bootstrapped.chatServer.start();
  return bootstrapped;
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

async function waitForDirectThread(chat, peerAccountId, label) {
  const thread = await waitFor(async () => {
    const result = await chat.bus.call("threads", "list", { limit: 50 });
    const threads = result && Array.isArray(result.threads) ? result.threads : [];
    return threads.find((item) => item && typeof item === "object"
      && String(item.peerAccountId || "").trim() === peerAccountId
      && String(item.peerInboxId || "").trim() && item.threadId);
  }, CHAT_TIMEOUT_MS, label);
  return thread.threadId;
}

function makeSafeStorage() {
  return {
    isEncryptionAvailable() { return true; },
    encryptString(v) { return Buffer.from("w:" + v, "utf8"); },
    decryptString(v) { const t = Buffer.from(v).toString("utf8"); return t.startsWith("w:") ? t.slice(2) : ""; },
  };
}

test("P1.3-pre pin: confirm → baseline DIRECT to the ceremony inbox → READY → bundle publication → ACTIVE, with a real delegated identity on a real pg home (no root key, no mocked sibling list)", { skip: SKIP ? "set RUN_LOCAL_MESH_E2E=1 and REZ_PG_TEST_URL to run" : false, timeout: 180_000 }, async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "rez-p13pre-activation-"));
  const rPort = await getFreePort();
  const homeWsPort = await getFreePort();
  const homeWsUrl = "ws://127.0.0.1:" + homeWsPort + "/ws";
  const schemaUrl = schemaScopedUrl(PG_URL, SCHEMA);
  const started = [];
  const chats = [];
  let vault = null;

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

    // The pg home with BOTH capabilities this pin needs: delegatedDevices
    // (pg backend — linking exists at all) and the E6 fan-out gate OPEN
    // (device.multiDeviceFanout) — the gate that makes bundle publication,
    // and therefore the activation transaction, real on this home. The old
    // device-link e2e left the gate CLOSED, which is why it never exercised
    // activation.
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

    // PRIMARY (seedful account with the root B) and CAROL (a plain peer).
    const primaryId = await makePrimaryIdentity();
    const carolId = await makePrimaryIdentity();

    await sleep(MESH_FORM_WAIT_MS);

    const primary = await bootChatLeaf({
      dataDir: path.join(tmp, "primary"), wsUrl: homeWsUrl,
      expectedChatServerIdentity: primaryId.chatServerIdentity, deviceKey: primaryId.deviceKey,
    });
    chats.push(primary.chatServer);
    const carol = await bootChatLeaf({
      dataDir: path.join(tmp, "carol"), wsUrl: homeWsUrl,
      expectedChatServerIdentity: carolId.chatServerIdentity, deviceKey: carolId.deviceKey,
    });
    chats.push(carol.chatServer);
    const carolAccountId = carol.ownerAccountId;

    // carol becomes a REAL active contact of the primary before the ceremony,
    // so the activation baseline has substantive state to carry.
    const invite = await primary.chatServer.bus.call("invite", "create", {
      kind: "direct", maxUses: 1, creatorDisplayName: "Primary",
    });
    const accepted = await carol.chatServer.bus.call("invite", "accept", {
      inviteCode: invite.inviteCode, acceptorDisplayName: "Carol",
    });
    assert.equal(accepted.peerAccountId, primary.ownerAccountId);
    await waitForDirectThread(primary.chatServer, carolAccountId, "primary thread to carol");

    // --- The REAL ceremony ---
    const events = [];
    primary.chatServer.bus.on("deviceLink.updated", (r) => {
      events.push(r && typeof r.toJSON === "function" ? r.toJSON() : r);
    });
    const ceremony = await primary.chatServer.bus.call("deviceLink", "start", {});
    assert.match(ceremony.linkCode, /^rez:link:v1:/);

    const requesterPromise = runDeviceLinkRequester({
      linkCode: ceremony.linkCode,
      wsUrl: homeWsUrl,
      timeoutMs: 60_000,
      logger: silentLogger,
      persistDelegation: async () => null,
    });
    const pending = await waitFor(async () => events.find((e) => e.state === "pending"), CHAT_TIMEOUT_MS, "device-link pending event");
    await primary.chatServer.bus.call("deviceLink", "approve", { newDeviceId: pending.newDeviceId });
    const requester = await requesterPromise;
    await waitFor(async () => events.find((e) => e.state === "confirmed"), CHAT_TIMEOUT_MS, "device-link confirmed event");

    // The ceremony/bootstrap inbox the requester self-minted and device.add
    // committed — the ONLY address the frozen invariant permits the baseline
    // to use.
    const ceremonyInboxId = requester.inboxId;
    assert.ok(typeof ceremonyInboxId === "string" && ceremonyInboxId.length > 0, "the requester exposes its ceremony inbox");

    // PIN 1 — publication really is deferred: before the delegated device
    // boots, NO bundle row exists for it (the activation gate is what this
    // whole transaction sequences). Delivery-timing note, discovered on this
    // real transport: the approver's push at confirm-instant cannot LAND yet
    // — a durable home accepts deposits only for CLAIMED inboxes
    // (isHostedHere = the shared claim registry), and the ceremony inbox is
    // first claimed by the delegated device's first connect. The device
    // therefore requests the baseline on entering BOOTSTRAPPING, and the
    // approver answers DIRECTLY at the inbox the signed request names —
    // still never DeviceSet-derived.
    assert.equal(await bundleRowCount(schemaUrl, requester.deviceId), 0,
      "no bundle exists before the delegated device's activation commits");

    // --- Provision the REAL delegated identity (no root key, by construction) ---
    vault = new DesktopVaultService({ dbPath: path.join(tmp, "newdev-vault.sqlite"), safeStorage: makeSafeStorage() }).open();
    await vault.createDelegatedAccount({
      profileName: "New Device",
      password: "correct horse battery staple",
      deviceKeyPair: requester.delegation.deviceKeyPair,
      inboxId: ceremonyInboxId,
      delegationBundle: {
        accountSignPublicKeyB64: requester.delegation.accountSignPublicKeyB64,
        accountDhKeyPair: requester.delegation.accountDhKeyPair,
        certChain: requester.delegation.certChain,
        cachedDeviceSet: requester.delegation.cachedDeviceSet,
      },
    });
    const delegatedIdentity = vault.getChatServerIdentity();
    const delegatedDeviceKey = vault.getActiveDeviceKey();
    assert.equal(delegatedIdentity.hasAdminRoot, false);
    assert.ok(!delegatedIdentity.privateKeyB64, "no account root key exists on the new device — the activation gate MUST engage");
    assert.equal(delegatedIdentity.inboxId, ceremonyInboxId, "the delegated leaf will claim exactly the ceremony inbox");

    // --- Boot the delegated leaf: BOOTSTRAPPING → drain baseline → READY →
    // publish → ACTIVE, all over real transports. ---
    const delegated = await bootChatLeaf({
      dataDir: path.join(tmp, "newdev"), wsUrl: homeWsUrl,
      expectedChatServerIdentity: delegatedIdentity, deviceKey: delegatedDeviceKey,
    });
    chats.push(delegated.chatServer);

    // PIN 2 — the baseline reached the bootstrap inbox and the activation
    // transaction completed. ACTIVE is itself the arrival proof: this
    // device's ONLY mailbox is the ceremony inbox, READY is reachable
    // exclusively through a verified activation-bound marker drained from it
    // with the horizon satisfied (never by timeout), and ACTIVE only through
    // the commit. (The raw mailbox_events row count is racy here by design —
    // ack-and-delete catch-up removes deposits as they are consumed.)
    await waitFor(async () => {
      const status = await delegated.chatServer.bus.call("device-activation", "status", {});
      return status && status.state === "ACTIVE";
    }, CHAT_TIMEOUT_MS, "delegated device activation reaches ACTIVE");

    // PIN 3 — bundle publication happened (the one externally visible
    // commit), at the durable system of record.
    assert.ok((await bundleRowCount(schemaUrl, requester.deviceId)) >= 1,
      "the new device's bundle row exists on the pg home — the READY→ACTIVE commit published");

    // PIN 4 — the baseline APPLIED, not merely arrived: the delegated device
    // surfaces carol's thread from replicated state alone (it never took part
    // in any invite).
    await waitForDirectThread(delegated.chatServer, carolAccountId, "delegated device holds carol's thread from the baseline");
  } finally {
    if (vault) { try { vault.close(); } catch (err) { silentLogger.warn("vault close failed", err && err.message ? err.message : err); } }
    for (const chat of chats.reverse()) {
      if (chat && typeof chat.stop === "function") await chat.stop().catch(() => {});
    }
    for (const app of started.reverse()) {
      if (app && typeof app.stop === "function") await app.stop().catch(() => {});
    }
    await withAdminPg(PG_URL, async (pool) => {
      await pool.query("DROP SCHEMA IF EXISTS " + SCHEMA + " CASCADE");
    }).catch((err) => {
      console.error("[p13pre activation e2e] schema teardown failed", err && err.message ? err.message : err);
    });
    await fs.rm(tmp, { recursive: true, force: true }).catch((err) => {
      console.error("[p13pre activation e2e] tmp cleanup failed", err && err.message ? err.message : err);
    });
  }
});
