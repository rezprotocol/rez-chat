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
import { DesktopVaultService } from "../electron/runtime/DesktopVaultService.mjs";
import { runDeviceLinkRequester } from "../src/desktop/runtime/DesktopDeviceLinkRunner.js";
import { MESH_FORM_WAIT_MS } from "./support/meshFormWait.js";

/**
 * LIVE local-mesh DEVICE-LINK CEREMONY e2e — the S2.5 S10 gate, fully un-mocked.
 *
 *   primary ─┐
 *   newdev  ─┼─ accountHome (rez-node, backend=pg) ── relayR
 *   carol   ─┘
 *
 * The whole PSK ceremony runs over real sockets: the PRIMARY (a seedful
 * account with the account root B) issues a link code via deviceLink.start;
 * the NEW DEVICE runs the real requester against the SAME home; the primary's
 * deviceLink.updated event surfaces the new device's fingerprint; the primary
 * approves; the requester's delegation provisions a REAL DesktopVaultService
 * v3 row; that vault boots a DELEGATED chat leaf — which then proves it WORKS
 * by inviting carol (a plain primary) and exchanging messages both ways.
 *
 * WHY ONE SHARED PG HOME (rez-chat#3). This test used to give every
 * participant its own fs-backed node. That topology CANNOT link devices, and
 * not by accident: an fs/desktop node wires no accountMutationSerializer (so
 * device.add has nothing to commit it) and no authority resolver (so delegated
 * session admission fails closed). GatewaySession states the rule directly —
 * "present => pg home (both dimensions); absent => FAIL CLOSED (fs/desktop wire
 * no resolver and are single-device)". Multi-device REQUIRES a hosted home, so
 * the fixture now matches the only topology in which the feature exists. The
 * node advertises this as SessionCapabilities.delegatedDevices, which is what
 * the chat server checks before starting a ceremony at all.
 *
 * Gated behind RUN_LOCAL_MESH_E2E=1 AND REZ_PG_TEST_URL (binds real loopback
 * ports + a real Postgres home).
 */

const RUN = process.env.RUN_LOCAL_MESH_E2E === "1";
const PG_URL = process.env.REZ_PG_TEST_URL || "";
const SKIP = !(RUN && PG_URL);
const SCHEMA = "test_s10_device_link";
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
      // ADR-RELAY-IDENTITY: relayKeyId is DERIVED from the node key — never configured.
      relay: { listenHost: "127.0.0.1", listenPort, advertisedHost: "127.0.0.1" },
    },
  };
}

// A seedful PRIMARY chat-server identity (holds B-sign priv + B-dh), the shape
// DesktopVaultService.getChatServerIdentity() returns for a v2 account.
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
    accountPubB64: chatServerKeys.publicKeyB64,
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

// The pg home connection string, pinned to an isolated schema via libpq options
// so this test's DDL/DML never collides with other pg test files.
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

// The ONE pg-backed account home every leaf in this test connects to. A pg
// backend is what wires the account-mutation serializer and authority resolver,
// which is what makes delegated devices possible at all — see the header.
async function startPgHome({ tmp, entryRelayKeyId, entryRelayPort }) {
  const dataDir = path.join(tmp, "home-node");
  await fs.mkdir(dataDir, { recursive: true });
  const wsPort = await getFreePort();
  const wsPath = "/ws";
  const nodeApp = await startRezNode({
    node: {
      ws: { host: "127.0.0.1", port: wsPort, path: wsPath },
      storage: {
        dataDir,
        backend: "pg",
        encryptionKeyB64: bytesToBase64(CRYPTO.randomBytes(32)),
        pg: { connectionString: schemaScopedUrl(PG_URL, SCHEMA), migrateOnBoot: true },
      },
      network: { participateInRouting: true, knownRelays: [knownRelay(entryRelayKeyId, entryRelayPort)] },
      mesh: { enabled: true, mode: "seed-only", seeds: [], minPeers: 1, maxPeers: 5 },
      relay: { listenHost: "127.0.0.1", listenPort: 0 },
    },
  });
  return { nodeApp, dataDir, wsUrl: "ws://127.0.0.1:" + wsPort + wsPath };
}

// Per-leaf node-local state directory. Leaves SHARE the home (one wsUrl) but
// each keeps its own local dir — the hosted-cluster shape.
async function leafDir(tmp, label) {
  const dir = path.join(tmp, label);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function bootChatLeaf({ dataDir, wsUrl, expectedChatServerIdentity, deviceKey }) {
  const bootstrapped = await bootstrapChatServer({
    nodeDataDir: dataDir, wsUrl, logger: silentLogger, expectedChatServerIdentity, deviceKey,
  });
  await bootstrapped.chatServer.start();
  return bootstrapped;
}

async function stopLeaf(app) {
  if (!app) return;
  if (app.chat && typeof app.chat.stop === "function") await app.chat.stop().catch(() => {});
  if (app.nodeApp && typeof app.nodeApp.stop === "function") await app.nodeApp.stop().catch(() => {});
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

async function waitForPeerLinkReady(chat, peerAccountId, label) {
  return waitFor(async () => {
    const result = await chat.bus.call("peer-links", "list", {});
    const items = result && Array.isArray(result.items) ? result.items : [];
    return items.find((item) => item && typeof item === "object"
      && String(item.peerAccountId || "").trim() === peerAccountId
      && (String(item.state || "").trim() === "established" || String(item.state || "").trim() === "session_established")
      && Boolean(String(item.peerInboxId || "").trim()));
  }, CHAT_TIMEOUT_MS, label);
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

async function waitForMessageText(chat, threadId, text, label) {
  return waitFor(async () => {
    const result = await chat.bus.call("thread.messages", "list", { threadId, limit: 50 });
    const items = result && Array.isArray(result.items) ? result.items : [];
    return items.find((m) => m && typeof m === "object"
      && (m.text === text || (m.payload && typeof m.payload === "object" && m.payload.text === text)));
  }, CHAT_TIMEOUT_MS, label);
}

function makeSafeStorage() {
  return {
    isEncryptionAvailable() { return true; },
    encryptString(v) { return Buffer.from("w:" + v, "utf8"); },
    decryptString(v) { const t = Buffer.from(v).toString("utf8"); return t.startsWith("w:") ? t.slice(2) : ""; },
  };
}

test("live local mesh: the full PSK device-link ceremony provisions a delegated device that then messages a third peer", { skip: SKIP ? "set RUN_LOCAL_MESH_E2E=1 and REZ_PG_TEST_URL to run" : false, timeout: 180_000 }, async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "rez-local-mesh-devlink-"));
  const rPort = await getFreePort();
  const started = [];
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

    // The ONE pg home. Every leaf below connects to it; carol keeps her own
    // account on the same node (the hosted base case: many accounts, one home).
    const home = await startPgHome({ tmp, entryRelayKeyId: relayKeyId, entryRelayPort: rPort });
    started.push({ nodeApp: home.nodeApp });

    // PRIMARY leaf (seedful account with B).
    const primaryId = await makePrimaryIdentity();
    const primary = await bootChatLeaf({
      dataDir: await leafDir(tmp, "primary"), wsUrl: home.wsUrl,
      expectedChatServerIdentity: primaryId.chatServerIdentity, deviceKey: primaryId.deviceKey,
    });
    const primaryLeaf = { chat: primary.chatServer, accountId: primary.ownerAccountId };
    started.push(primaryLeaf);

    // CAROL leaf (plain primary — the third peer the provisioned device talks to).
    const carolId = await makePrimaryIdentity();
    const carol = await bootChatLeaf({
      dataDir: await leafDir(tmp, "carol"), wsUrl: home.wsUrl,
      expectedChatServerIdentity: carolId.chatServerIdentity, deviceKey: carolId.deviceKey,
    });
    const carolLeaf = { chat: carol.chatServer, accountId: carol.ownerAccountId };
    started.push(carolLeaf);

    // NEW-DEVICE local dir (no chat server yet — the ceremony provisions it).
    // It joins the SAME home: a second device of one account is precisely what a
    // hosted home exists to carry.
    const newdevDir = await leafDir(tmp, "newdev");

    await sleep(MESH_FORM_WAIT_MS); // mesh form

    // --- The ceremony ---
    const pendingEvents = [];
    primaryLeaf.chat.bus.on("deviceLink.updated", (r) => {
      pendingEvents.push(r && typeof r.toJSON === "function" ? r.toJSON() : r);
    });

    const started2 = await primaryLeaf.chat.bus.call("deviceLink", "start", {});
    assert.match(started2.linkCode, /^rez:link:v1:/);

    // The NEW device runs the real requester against its OWN node.
    const requesterPromise = runDeviceLinkRequester({
      linkCode: started2.linkCode,
      wsUrl: home.wsUrl,
      timeoutMs: 60_000,
      logger: silentLogger,
      persistDelegation: async () => null,
    });

    // The primary sees the request pending with the new device's fingerprint.
    const pending = await waitFor(async () => pendingEvents.find((e) => e.state === "pending"), CHAT_TIMEOUT_MS, "device-link pending event");
    assert.match(pending.fingerprint, /^[0-9a-f]{4}(-[0-9a-f]{4}){4}$/);
    assert.match(pending.newDeviceId, /^rez:dev:[0-9a-f]{64}$/);

    // Human approves.
    await primaryLeaf.chat.bus.call("deviceLink", "approve", { newDeviceId: pending.newDeviceId });

    const requester = await requesterPromise;
    assert.equal(requester.deviceId, pending.newDeviceId, "the requester IS the approved device");
    await waitFor(async () => pendingEvents.find((e) => e.state === "confirmed"), CHAT_TIMEOUT_MS, "device-link confirmed event");

    // --- Provision a REAL delegated vault from the ceremony output ---
    vault = new DesktopVaultService({ dbPath: path.join(tmp, "newdev-vault.sqlite"), safeStorage: makeSafeStorage() }).open();
    await vault.createDelegatedAccount({
      profileName: "New Device",
      password: "correct horse battery staple",
      deviceKeyPair: requester.delegation.deviceKeyPair,
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
    assert.equal(delegatedIdentity.accountId, primaryLeaf.accountId, "the linked device runs AS the primary's account");

    // --- Boot the DELEGATED leaf from the vault + prove it WORKS ---
    const delegated = await bootChatLeaf({
      dataDir: newdevDir, wsUrl: home.wsUrl,
      expectedChatServerIdentity: delegatedIdentity, deviceKey: delegatedDeviceKey,
    });
    const delegatedLeaf = { chat: delegated.chatServer, accountId: delegated.ownerAccountId, bootstrapped: delegated };
    // (its node is already in `started`; register the chat for teardown)
    started.push({ chat: delegated.chatServer });
    assert.equal(delegatedLeaf.bootstrapped.peerLinkService.hasAdminRoot, false);

    // The provisioned delegated device invites carol; carol accepts.
    const invite = await delegatedLeaf.chat.bus.call("invite", "create", { kind: "direct", maxUses: 1, creatorDisplayName: "New Device" });
    assert.ok(invite.inviteCode);
    const accepted = await carolLeaf.chat.bus.call("invite", "accept", { inviteCode: invite.inviteCode, acceptorDisplayName: "Carol" });
    assert.equal(accepted.peerAccountId, delegatedLeaf.accountId, "carol resolves the linked device's ACCOUNT (the primary's B)");

    await waitForPeerLinkReady(delegatedLeaf.chat, carolLeaf.accountId, "delegated peer-link to carol");
    const delegatedThreadId = await waitForDirectThread(delegatedLeaf.chat, carolLeaf.accountId, "delegated thread to carol");
    const carolThreadId = accepted.threadId;

    const d2c = "linked device → carol " + Date.now();
    await delegatedLeaf.chat.bus.call("message", "send", { threadId: delegatedThreadId, messageId: "d2c_" + Date.now(), payload: { kind: "rez.chat.message.v1", text: d2c } });
    const gotByCarol = await waitForMessageText(carolLeaf.chat, carolThreadId, d2c, "carol receives the linked device's message");
    assert.equal(gotByCarol.senderAccountId, delegatedLeaf.accountId);

    const c2d = "carol → linked device " + Date.now();
    await carolLeaf.chat.bus.call("message", "send", { threadId: carolThreadId, messageId: "c2d_" + Date.now(), payload: { kind: "rez.chat.message.v1", text: c2d } });
    const gotByDelegated = await waitForMessageText(delegatedLeaf.chat, delegatedThreadId, c2d, "the linked device receives carol's reply");
    assert.equal(gotByDelegated.senderAccountId, carolLeaf.accountId);

    // Armed guard: the delegated leaf's account-sign authority throws.
    await assert.rejects(
      () => delegatedLeaf.bootstrapped.peerLinkService.signer.sign(new Uint8Array([1])),
      /delegated and holds no account root key/,
    );
  } finally {
    if (vault) { try { vault.close(); } catch (err) { /* best-effort */ } }
    for (const app of started.reverse()) {
      if (app && app.chat) await stopLeaf(app);
      else if (app && typeof app.stop === "function") await app.stop().catch(() => {});
      else if (app && app.nodeApp) await stopLeaf(app);
    }
    await withAdminPg(PG_URL, async (pool) => {
      await pool.query("DROP SCHEMA IF EXISTS " + SCHEMA + " CASCADE");
    }).catch((err) => {
      console.error("[device-link e2e] schema teardown failed", err && err.message ? err.message : err);
    });
    await fs.rm(tmp, { recursive: true, force: true }).catch((err) => {
      console.error("[device-link e2e] tmp cleanup failed", err && err.message ? err.message : err);
    });
  }
});
