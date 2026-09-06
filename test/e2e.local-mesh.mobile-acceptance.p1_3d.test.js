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
import { unlockKeystoreAccount, InboxClaimStore } from "@rezprotocol/sdk/client";
import { createKeyValueBackedPeerLinkStorage } from "@rezprotocol/sdk/peer-link";
import { SeedKeys } from "@rezprotocol/sdk/crypto/seedDerivation";
import { Bip39 } from "@rezprotocol/sdk/crypto/bip39";
import { bootstrapChatServer } from "../src/server/index.js";
import { enrollDelegatedDevice } from "../src/mobile/enrollDelegatedDevice.js";
import { activateDelegatedDevice } from "../src/mobile/activateDelegatedDevice.js";
import { prepareDelegatedCoreBoot } from "../src/mobile/prepareDelegatedCoreBoot.js";
import { startRezChatCore } from "../src/mobile/startRezChatCore.js";
import { DeviceActivationJournal, ACTIVATION_STATES } from "../src/server/device/DeviceActivationJournal.js";
import { readPortablePrimaryInboxId } from "../src/server/inbox/PortableInboxEstablisher.js";
import { MESH_FORM_WAIT_MS } from "./support/meshFormWait.js";

/**
 * P1.3d ACCEPTANCE — the full split-transport enrollment handoff under ugly
 * real conditions (plans/MOBILE_PLATFORM_INTEGRATION_PLAN.md §8; the P1.3d
 * charter as ruled at the P1.3c close).
 *
 *   primary ── pgHome1 (ACCOUNT home; pg, fanout) ─┐
 *   carol ──── pgHome2 (HER home; pg, fanout) ─────┼── relay ── portableNode (fs)
 *   "phone" ── enrollment via pgHome1, steady state on portableNode
 *
 * The matrix, in one continuous life of one phone:
 *
 *   0. killed-mid-ceremony NEGATIVE: pre-envelope-persist death leaves
 *      NOTHING durable; a fresh ceremony is required (no resumable
 *      requester state exists, deliberately).
 *   1. KILL MID-BOOTSTRAPPING (the primary is unreachable): the bounded
 *      session times out in BOOTSTRAPPING; journal durable; nothing
 *      published; NO portable inbox minted (the commit never ran).
 *   2. KILL AT READY (the portable provider is down): the baseline lands,
 *      READY commits to the journal, the portable claim is MINTED AND
 *      DURABLE but the lease fails → publication is impossible → nothing
 *      published; the rerun REUSES the same portable inbox. Never a second
 *      mint, never an early publish, never a ceremony re-run.
 *   3. Heal → ACTIVE: the bundle carries the SAME prepared portable inbox.
 *   4. KILL AFTER ACTIVE: a verb rerun is alreadyActive (zero ACCOUNT
 *      construction); the ordinary steady boot is unlock →
 *      prepareDelegatedCoreBoot → startRezChatCore → CLAIMANT.
 *   5. FRAME-LEVEL steady-state inspection: every frame the steady session
 *      ever sends is recorded — the hellos are authMode=claimant, and NO
 *      frame anywhere carries the account identity public key, the
 *      device id, or an account-mode hello. AccountControlChannel
 *      executeCount stays 0.
 *   6. CROSS-PROVIDER DELIVERY: carol (on HER OWN pg home) sends one
 *      message; it fans out per the published device set and lands in the
 *      phone's PORTABLE inbox across three nodes (pg2 → relay → portable);
 *      the phone drains and surfaces it.
 *   7. THE PAYOFF: the ACCOUNT home (pg1) is killed outright — and carol's
 *      next message still reaches the phone through the portable provider.
 *      After activation, the account home is not on the ordinary delivery
 *      critical path.
 *
 * HISTORY NOTE: this file is buildable at all because P1.3d's first probe
 * found the shipped cross-node routing defect — HostedInboxRegistry's
 * announce projection dropped the lease pair from inside the claimant's
 * signed delegation bytes, so every fresh (v2) claim was unroutable across
 * nodes ("missing/invalid claimant delegation" → "no route to target").
 * The three long-failing relay-routed e2es were that defect, not the
 * machine.
 *
 * Gated behind RUN_LOCAL_MESH_E2E=1 AND REZ_PG_TEST_URL.
 */

const RUN = process.env.RUN_LOCAL_MESH_E2E === "1";
const PG_URL = process.env.REZ_PG_TEST_URL || "";
const SKIP = !(RUN && PG_URL);
const SCHEMA1 = "test_p13d_account_home";
const SCHEMA2 = "test_p13d_carol_home";
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

function pgHomeConfig({ dataDir, wsPort, schemaUrl, relayKeyId, rPort }) {
  return {
    node: {
      ws: { host: "127.0.0.1", port: wsPort, path: "/ws" },
      storage: {
        dataDir,
        backend: "pg",
        encryptionKeyB64: bytesToBase64(CRYPTO.randomBytes(32)),
        pg: { connectionString: schemaUrl, migrateOnBoot: true },
      },
      network: { participateInRouting: true, knownRelays: [knownRelay(relayKeyId, rPort)] },
      mesh: { enabled: true, mode: "seed-only", seeds: [], minPeers: 1, maxPeers: 8 },
      relay: { listenHost: "127.0.0.1", listenPort: 0 },
      device: { multiDeviceFanout: true },
    },
  };
}

function portableNodeConfig({ dataDir, wsPort, relayKeyId, rPort }) {
  return {
    node: {
      ws: { host: "127.0.0.1", port: wsPort, path: "/ws" },
      storage: { dataDir },
      network: { participateInRouting: true, knownRelays: [knownRelay(relayKeyId, rPort)] },
      mesh: { enabled: true, mode: "seed-only", seeds: [], minPeers: 1, maxPeers: 8 },
      relay: { listenHost: "127.0.0.1", listenPort: 0 },
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

async function bundleRowCount(schemaUrl, deviceId) {
  return withAdminPg(schemaUrl, async (pool) => {
    const r = await pool.query("SELECT count(*)::int AS n FROM account_device_bundle WHERE device_id = $1", [deviceId]);
    return r.rows[0] ? r.rows[0].n : 0;
  });
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
  }
  getKeyValueStore(name) {
    const key = name == null ? "" : String(name);
    if (!this._stores.has(key)) this._stores.set(key, new TestKVStore());
    return this._stores.get(key);
  }
  getPeerLinkStorage() { return this._peerLinkStorage; }
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

async function waitForInboundText(chat, peerAccountId, text, label) {
  return waitFor(async () => {
    const result = await chat.bus.call("threads", "list", { limit: 50 });
    const threads = result && Array.isArray(result.threads) ? result.threads : [];
    for (const t of threads) {
      if (!t || String(t.peerAccountId || "").trim() !== peerAccountId || !t.threadId) continue;
      const msgs = await chat.bus.call("thread.messages", "list", { threadId: t.threadId, limit: 50 });
      const items = msgs && Array.isArray(msgs.items) ? msgs.items : [];
      const hit = items.find((m) => m && (m.text === text || (m.payload && typeof m.payload === "object" && m.payload.text === text)));
      if (hit) return { threadId: t.threadId, message: hit };
    }
    return null;
  }, CHAT_TIMEOUT_MS, label);
}

function frameToText(data) {
  if (typeof data === "string") return data;
  try {
    return Buffer.from(data).toString("utf8");
  } catch {
    return "";
  }
}

test("P1.3d: the full split-transport handoff under kills — ceremony death, BOOTSTRAPPING death, READY death with the portable provider down, post-ACTIVE reboot, frame-pure claimant steady state, cross-provider delivery, and delivery surviving the account home's death", { skip: SKIP ? "set RUN_LOCAL_MESH_E2E=1 and REZ_PG_TEST_URL to run" : false, timeout: 420_000 }, async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "rez-p13d-"));
  const rPort = await getFreePort();
  const home1WsPort = await getFreePort();
  const home2WsPort = await getFreePort();
  const portableWsPort = await getFreePort();
  const home1WsUrl = "ws://127.0.0.1:" + home1WsPort + "/ws";
  const home2WsUrl = "ws://127.0.0.1:" + home2WsPort + "/ws";
  const portableWsUrl = "ws://127.0.0.1:" + portableWsPort + "/ws";
  const schema1Url = schemaScopedUrl(PG_URL, SCHEMA1);
  const schema2Url = schemaScopedUrl(PG_URL, SCHEMA2);
  const running = new Map(); // label -> app (so kills are explicit and restarts reuse data dirs)
  const chats = [];
  let steadyCore = null;

  await withAdminPg(PG_URL, async (pool) => {
    for (const schema of [SCHEMA1, SCHEMA2]) {
      await pool.query("DROP SCHEMA IF EXISTS " + schema + " CASCADE");
      await pool.query("CREATE SCHEMA " + schema);
    }
  });

  try {
    const relayApp = await startRezNode(relayOnlyConfig({
      dataDir: path.join(tmp, "relay"), listenPort: rPort, knownRelays: [],
    }));
    running.set("relay", relayApp);
    const relayKeyId = relayApp.runtime.getIdentity().relayKeyId;

    running.set("pg1", await startRezNode(pgHomeConfig({
      dataDir: path.join(tmp, "pg1"), wsPort: home1WsPort, schemaUrl: schema1Url, relayKeyId, rPort,
    })));
    running.set("pg2", await startRezNode(pgHomeConfig({
      dataDir: path.join(tmp, "pg2"), wsPort: home2WsPort, schemaUrl: schema2Url, relayKeyId, rPort,
    })));
    running.set("portable", await startRezNode(portableNodeConfig({
      dataDir: path.join(tmp, "portable"), wsPort: portableWsPort, relayKeyId, rPort,
    })));

    const primaryId = await makePrimaryIdentity();
    const carolId = await makePrimaryIdentity();
    await sleep(MESH_FORM_WAIT_MS);

    let primary = await bootstrapChatServer({
      nodeDataDir: path.join(tmp, "primary"), wsUrl: home1WsUrl, logger: silentLogger,
      expectedChatServerIdentity: primaryId.chatServerIdentity, deviceKey: primaryId.deviceKey,
    });
    await primary.chatServer.start();
    chats.push(primary.chatServer);
    const carol = await bootstrapChatServer({
      nodeDataDir: path.join(tmp, "carol"), wsUrl: home2WsUrl, logger: silentLogger,
      expectedChatServerIdentity: carolId.chatServerIdentity, deviceKey: carolId.deviceKey,
    });
    await carol.chatServer.start();
    chats.push(carol.chatServer);

    // CROSS-NODE contact: primary (pg1) ↔ carol (pg2), rendezvous + deposits
    // over the relay — the leg the routing fix revived.
    const invite = await primary.chatServer.bus.call("invite", "create", {
      kind: "direct", maxUses: 1, creatorDisplayName: "Primary",
    });
    await carol.chatServer.bus.call("invite", "accept", {
      inviteCode: invite.inviteCode, acceptorDisplayName: "Carol",
    });
    await waitForDirectThread(primary.chatServer, carol.ownerAccountId, "primary thread to carol (cross-node)");
    const carolThreadId = await waitForDirectThread(carol.chatServer, primary.ownerAccountId, "carol thread to primary (cross-node)");

    // ---- 0. KILLED-MID-CEREMONY NEGATIVE: the requester dies (deadline)
    // before the delegation is ever verified/persisted. Nothing durable
    // exists; the ceremony has NO resumable requester state, deliberately.
    const phoneKeystore = new KeystoreStore({ storageProvider: memoryStorageProvider() });
    const abandoned = await primary.chatServer.bus.call("deviceLink", "start", {});
    await assert.rejects(
      () => enrollDelegatedDevice({
        linkCode: abandoned.linkCode,
        password: "phone-unlock-secret",
        cryptoProvider: CRYPTO,
        wsFactory: (url) => new WebSocket(url),
        uplinks: [home1WsUrl],
        keystoreStore: phoneKeystore,
        timeoutMs: 4_000, // nobody will approve — the requester dies waiting
        logger: silentLogger,
      }),
      (err) => err && err.code === "DEVICE_LINK_TIMEOUT",
    );
    assert.equal(await phoneKeystore.hasKeystore(), false,
      "pre-envelope-persist death leaves NOTHING durable — a fresh ceremony is required");
    await primary.chatServer.bus.call("deviceLink", "cancel", {});

    // ---- The REAL ceremony (fresh code — nothing resumed). ----
    const events = [];
    primary.chatServer.bus.on("deviceLink.updated", (r) => {
      events.push(r && typeof r.toJSON === "function" ? r.toJSON() : r);
    });
    const ceremony = await primary.chatServer.bus.call("deviceLink", "start", {});
    const enrollPromise = enrollDelegatedDevice({
      linkCode: ceremony.linkCode,
      password: "phone-unlock-secret",
      profileName: "Phone",
      cryptoProvider: CRYPTO,
      wsFactory: (url) => new WebSocket(url),
      uplinks: [home1WsUrl],
      keystoreStore: phoneKeystore,
      timeoutMs: 60_000,
      logger: silentLogger,
    });
    const pending = await waitFor(async () => events.find((e) => e.state === "pending"), CHAT_TIMEOUT_MS, "device-link pending event");
    await primary.chatServer.bus.call("deviceLink", "approve", { newDeviceId: pending.newDeviceId });
    const enrolled = await enrollPromise;

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
    const activationArgs = {
      identity: phoneIdentity,
      deviceKey: phoneDeviceKey,
      storageProvider: phoneStorage,
      cryptoProvider: CRYPTO,
      accountHomeUplinks: [home1WsUrl],
      portableUplinks: [portableWsUrl],
      wsFactory: (url) => new WebSocket(url),
      logger: silentLogger,
    };
    const readJournal = async () => {
      const journal = new DeviceActivationJournal({ storageProvider: phoneStorage });
      await journal.hydrate();
      return journal.get();
    };

    // ---- 1. KILL MID-BOOTSTRAPPING: the PRIMARY is gone, so no baseline
    // can arrive. The bounded session times out; durable state resumes the
    // exact phase; nothing is visible externally; NO portable inbox exists
    // (the commit never ran, so nothing was minted).
    await primary.chatServer.stop();
    await assert.rejects(
      () => activateDelegatedDevice({ ...activationArgs, timeoutMs: 12_000 }),
      (err) => err && err.code === "ACTIVATION_TIMEOUT" && err.state === ACTIVATION_STATES.BOOTSTRAPPING,
    );
    assert.equal((await readJournal()).state, ACTIVATION_STATES.BOOTSTRAPPING, "the journal durably holds the incomplete phase");
    assert.equal(await bundleRowCount(schema1Url, enrolled.deviceId), 0, "nothing published early");
    assert.equal(await readPortablePrimaryInboxId(phoneStorage), null, "no portable inbox was minted before the commit needed one");

    // The primary comes back (same storage — a crash-restart, not a new
    // device) and can now answer the buffered/re-requested baseline.
    primary = await bootstrapChatServer({
      nodeDataDir: path.join(tmp, "primary"), wsUrl: home1WsUrl, logger: silentLogger,
      expectedChatServerIdentity: primaryId.chatServerIdentity, deviceKey: primaryId.deviceKey,
    });
    await primary.chatServer.start();
    chats.push(primary.chatServer);

    // ---- 2. KILL AT READY: the portable provider is DOWN. The baseline
    // drains, READY commits to the journal, the portable claim is minted
    // and durably persisted — but the lease cannot be accepted, so
    // publication is impossible and the device stays externally invisible.
    await running.get("portable").stop();
    running.delete("portable");
    await assert.rejects(
      () => activateDelegatedDevice({ ...activationArgs, timeoutMs: 30_000 }),
      (err) => err && err.code === "ACTIVATION_TIMEOUT" && err.state === ACTIVATION_STATES.READY,
    );
    assert.equal((await readJournal()).state, ACTIVATION_STATES.READY);
    assert.equal(await bundleRowCount(schema1Url, enrolled.deviceId), 0,
      "READY with no portable lease publishes NOTHING — there is no bootstrap-inbox fallback");
    const preparedPortableId = await readPortablePrimaryInboxId(phoneStorage);
    assert.ok(preparedPortableId, "the portable claim was minted and its pointer is durable");
    assert.notEqual(preparedPortableId, enrolled.bootstrapInboxId);
    // Read-only view of the claim store: custody exists, no accepted lease.
    const claimPeek = new InboxClaimStore({ storageProvider: phoneStorage, cryptoProvider: CRYPTO });
    await claimPeek.hydrate();
    assert.ok(claimPeek.get(preparedPortableId), "claimant + close custody persisted");
    assert.equal(claimPeek.leaseState(preparedPortableId), null, "no lease was recorded from the failed round-trip");

    // ---- 3. HEAL → ACTIVE: same portable node identity (same data dir).
    // The rerun REUSES the prepared claim — never mints a second inbox —
    // and the one externally visible commit finally happens.
    running.set("portable", await startRezNode(portableNodeConfig({
      dataDir: path.join(tmp, "portable"), wsPort: portableWsPort, relayKeyId, rPort,
    })));
    await sleep(2_000);
    const activated = await activateDelegatedDevice({ ...activationArgs, timeoutMs: 90_000 });
    assert.equal(activated.state, ACTIVATION_STATES.ACTIVE);
    assert.equal(activated.portableInboxId, preparedPortableId,
      "the rerun published the SAME portable inbox it prepared before the crash — never a second mint");
    const bundleRow = await withAdminPg(schema1Url, async (pool) => {
      const r = await pool.query("SELECT bundle_json FROM account_device_bundle WHERE device_id = $1", [enrolled.deviceId]);
      return r.rows[0] ? r.rows[0].bundle_json : null;
    });
    const bundle = typeof bundleRow === "string" ? JSON.parse(bundleRow) : bundleRow;
    assert.equal(bundle.inboxId, preparedPortableId, "the world learns the portable address");

    // ---- 4. KILL AFTER ACTIVE: a rerun is a durable-state no-op — and the
    // ordinary boot is the P1.3c mapping into the claimant core.
    const rerun = await activateDelegatedDevice(activationArgs);
    assert.equal(rerun.alreadyActive, true);
    assert.equal(rerun.portableInboxId, preparedPortableId);

    // ---- 5. STEADY STATE with FRAME RECORDING: every byte the phone's
    // claimant session sends is captured.
    const sentFrames = [];
    const recordingWsFactory = (url) => {
      const ws = new WebSocket(url);
      const rawSend = ws.send.bind(ws);
      ws.send = (data, ...rest) => {
        sentFrames.push(frameToText(data));
        return rawSend(data, ...rest);
      };
      return ws;
    };
    const bootInputs = await prepareDelegatedCoreBoot({
      unlocked,
      storageProvider: phoneStorage,
      cryptoProvider: CRYPTO,
      uplinks: [portableWsUrl],
      wsFactory: recordingWsFactory,
      logger: silentLogger,
    });
    steadyCore = await startRezChatCore(bootInputs);
    await steadyCore.chatServer.start();
    assert.equal(steadyCore.chatServer.bus.runtime.sessionMode, "claimant");
    assert.equal(steadyCore.inboxClaimant.inboxId, preparedPortableId);

    // ---- 6. CROSS-PROVIDER DELIVERY: carol (pg2) → the account. The fanned
    // copy for the phone routes pg2 → relay → portableNode into the
    // PORTABLE inbox; the phone drains and surfaces it.
    const text1 = "carol → phone via portable inbox " + Date.now();
    await carol.chatServer.bus.call("message", "send", {
      threadId: carolThreadId,
      messageId: "p13d_m1_" + Date.now(),
      payload: { kind: "rez.chat.message.v1", text: text1 },
    });
    await waitForInboundText(steadyCore.chatServer, carol.ownerAccountId, text1,
      "the phone surfaces carol's message from its PORTABLE inbox (cross-provider)");

    // ---- 7. THE PAYOFF: kill the ACCOUNT home entirely. Ordinary delivery
    // to the phone must not care. (The primary's copy is undeliverable — its
    // home is gone — so the SENDER may see a partial fan-out error; the
    // phone's copy must land regardless.)
    await primary.chatServer.stop();
    await running.get("pg1").stop();
    running.delete("pg1");
    const text2 = "carol → phone with the ACCOUNT HOME DEAD " + Date.now();
    try {
      await carol.chatServer.bus.call("message", "send", {
        threadId: carolThreadId,
        messageId: "p13d_m2_" + Date.now(),
        payload: { kind: "rez.chat.message.v1", text: text2 },
      });
    } catch (err) {
      // A partial fan-out error names the dead primary's copy, not the
      // phone's. The commit-retry machinery owns the primary's catch-up.
      silentLogger.warn("send with account home dead reported: " + (err && err.message ? err.message : err));
    }
    await waitForInboundText(steadyCore.chatServer, carol.ownerAccountId, text2,
      "the phone still receives ordinary mail with the account home DEAD — the split transport is the delivery path");

    // ---- FRAME INSPECTION (accumulated over the whole steady phase, drains
    // and acks included): claimant-pure, mechanically.
    assert.ok(sentFrames.length > 0, "the steady session sent frames to inspect");
    const helloFrames = sentFrames.filter((f) => f.includes("\"authMode\""));
    assert.ok(helloFrames.length > 0, "at least one session hello was captured");
    for (const frame of helloFrames) {
      assert.ok(frame.includes("\"authMode\":\"claimant\""), "every hello is claimant-mode: " + frame.slice(0, 200));
    }
    const forbidden = [
      ["\"authMode\":\"account\"", "an account-mode hello"],
      ["accountIdentityPublicKeyB64", "the account identity key field"],
      [phoneIdentity.publicKeyB64, "the account identity public key value"],
      [phoneDeviceKey.deviceId, "the device id"],
      [enrolled.bootstrapInboxId, "the bootstrap inbox address"],
    ];
    for (const frame of sentFrames) {
      for (const [needle, label] of forbidden) {
        assert.ok(!frame.includes(needle),
          "steady-state frame carries " + label + " — the hosted identity path leaked back in: " + frame.slice(0, 300));
      }
    }
    assert.equal(steadyCore.chatServer.bus.runtime.accountControl.executeCount, 0,
      "zero AccountControlChannel executions across the whole steady phase");
    assert.equal(steadyCore.chatServer.bus.runtime.accountControl.active, false);
  } finally {
    if (steadyCore) {
      await steadyCore.chatServer.stop().catch((err) => {
        console.error("[p13d e2e] steady core stop failed", err && err.message ? err.message : err);
      });
    }
    for (const chat of chats.reverse()) {
      if (chat && typeof chat.stop === "function") await chat.stop().catch(() => {});
    }
    for (const app of Array.from(running.values()).reverse()) {
      if (app && typeof app.stop === "function") await app.stop().catch(() => {});
    }
    await withAdminPg(PG_URL, async (pool) => {
      for (const schema of [SCHEMA1, SCHEMA2]) {
        await pool.query("DROP SCHEMA IF EXISTS " + schema + " CASCADE");
      }
    }).catch((err) => {
      console.error("[p13d e2e] schema teardown failed", err && err.message ? err.message : err);
    });
    await fs.rm(tmp, { recursive: true, force: true }).catch((err) => {
      console.error("[p13d e2e] tmp cleanup failed", err && err.message ? err.message : err);
    });
  }
});
