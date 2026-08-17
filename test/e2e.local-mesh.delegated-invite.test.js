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
  AccountDeviceCapabilityV1,
  ACCOUNT_DEVICE_CAPABILITY_PURPOSE,
} from "@rezprotocol/core";
import { bootstrapChatServer } from "../src/server/index.js";

/**
 * LIVE local-mesh DELEGATED-DEVICE e2e — the S2.5 S9 gate, fully un-mocked.
 *
 *   aliceChat (PRIMARY)   ─┐
 *                          ├─ accountHome (rez-node, backend=pg) ── relayR
 *   bobChat   (DELEGATED) ─┘
 *
 * Bob's stack is a SEEDLESS delegated device: his identity is the account
 * PUBLIC key + a B→C capability chain + the account X25519 DH key — the
 * account private key is ZEROED before his leaf boots, so any latent use
 * fails cryptographically. End to end over real sockets this proves:
 *
 *   - delegated WS session auth (C signs the challenge + chain; node S7 path)
 *   - the inbox claimed by C routes deposits (claimant-blindness holds)
 *   - Bob CREATES the invite: C-signed envelope + DurableRecordV2 (owner=B,
 *     signer=C, "peerLink.create") published to and resolved from the REAL
 *     overlay — Alice (a plain primary) accepts it by code
 *   - X3DH completes both ways; messages flow Bob→Alice and Alice→Bob
 *
 * WHY ONE SHARED PG HOME (rez-chat#3). Bob is a DELEGATED device, and a
 * delegated session is admitted only by a home that wires an authority
 * resolver — which an fs/desktop node does not. GatewaySession fails such a
 * session closed on purpose ("absent => FAIL CLOSED (fs/desktop wire no
 * resolver and are single-device)"), so the old per-leaf fs topology could
 * never have authenticated Bob at all; the test died at chat-server start,
 * before reaching anything it meant to prove. Both leaves now share one
 * pg-backed home, the only topology where delegated devices exist.
 *
 * Gated behind RUN_LOCAL_MESH_E2E=1 AND REZ_PG_TEST_URL (binds real loopback
 * ports + a real Postgres home).
 */

const RUN = process.env.RUN_LOCAL_MESH_E2E === "1";
const PG_URL = process.env.REZ_PG_TEST_URL || "";
const SKIP = !(RUN && PG_URL);
const SCHEMA = "test_s9_delegated_invite";
const CHAT_TIMEOUT_MS = 30_000;
const CRYPTO = new NodeCryptoProvider();

const silentLogger = { log() {}, info() {}, warn() {}, error() {}, debug() {} };

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

function buildLeafCert({ accountPubB64, accountPrivBytes, granteePubB64, capabilities }) {
  const now = Date.now();
  const fields = {
    v: 1,
    purpose: ACCOUNT_DEVICE_CAPABILITY_PURPOSE,
    accountIdentityPublicKeyB64: accountPubB64,
    parentCertId: null,
    granteeDevicePublicKeyB64: granteePubB64,
    granteeDeviceId: DeviceRegistrationV1.deviceIdFor(granteePubB64),
    capabilities,
    maxDelegationDepth: 0,
    issuedAtMs: now - 1000,
    expiresAtMs: now + 7 * 24 * 60 * 60 * 1000,
    signerPublicKeyB64: accountPubB64,
  };
  const certId = AccountDeviceCapabilityV1.deriveCertId(fields);
  const sigBytes = CRYPTO.sign({ privateKey: accountPrivBytes, msg: AccountDeviceCapabilityV1.signableBytes({ ...fields, certId }) });
  return new AccountDeviceCapabilityV1({ ...fields, certId, sig: { alg: "ed25519", sigB64: bytesToBase64(sigBytes) } });
}

// Mint the delegation the way the S10 ceremony/K4 vault will: the new device
// mints C, the primary signs the single-hop chain, the account X25519 DH key
// rides along — then the account PRIVATE key is ZEROED before the leaf boots.
function makeDelegatedIdentity() {
  const b = CRYPTO.generateSigningKeyPair();
  const c = CRYPTO.generateSigningKeyPair();
  const dh = CRYPTO.dhGenerateKeyPair();
  const accountPubB64 = bytesToBase64(b.publicKey);
  const deviceKeyPair = { publicKeyB64: bytesToBase64(c.publicKey), privateKeyB64: bytesToBase64(c.privateKey) };
  const leafCert = buildLeafCert({
    accountPubB64,
    accountPrivBytes: b.privateKey,
    granteePubB64: deviceKeyPair.publicKeyB64,
    capabilities: ["peerLink.create", "deviceSet.publish"],
  });
  b.privateKey.fill(0);
  return {
    accountId: deriveAccountIdFromPublicKey(b.publicKey),
    accountPubB64,
    deviceKey: {
      deviceId: DeviceRegistrationV1.deviceIdFor(deviceKeyPair.publicKeyB64),
      deviceKeyPair,
    },
    chatServerIdentity: {
      accountId: deriveAccountIdFromPublicKey(b.publicKey),
      publicKeyB64: accountPubB64,
      privateKeyB64: null,
      hasAdminRoot: false,
      certChain: [leafCert.toJSON()],
      accountIdentityDhKeyPair: {
        publicKeyB64: bytesToBase64(dh.publicKey),
        privateKeyB64: bytesToBase64(dh.privateKey),
      },
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

// The ONE pg-backed home both leaves connect to. Its authority resolver is what
// admits Bob's DELEGATED session; see the header.
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
  return { nodeApp, wsUrl: "ws://127.0.0.1:" + wsPort + wsPath };
}

// A chat leaf on the SHARED home. Each leaf keeps its own node-local dir; only
// the home is shared (the hosted-cluster shape).
async function startChatLeaf({ tmp, label, wsUrl, expectedChatServerIdentity = null, deviceKey = null }) {
  const dataDir = path.join(tmp, label);
  await fs.mkdir(dataDir, { recursive: true });
  const bootstrapped = await bootstrapChatServer({
    nodeDataDir: dataDir,
    wsUrl,
    logger: silentLogger,
    expectedChatServerIdentity,
    deviceKey,
  });
  await bootstrapped.chatServer.start();
  return { label, chat: bootstrapped.chatServer, accountId: bootstrapped.ownerAccountId, bootstrapped };
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
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) {
      lastError = err;
    }
    await sleep(400);
  }
  throw new Error("Timed out waiting for " + label + (lastError && lastError.message ? ": " + lastError.message : ""));
}

async function waitForPeerLinkReady(chat, peerAccountId, label) {
  return waitFor(async () => {
    const result = await chat.bus.call("peer-links", "list", {});
    const items = result && Array.isArray(result.items) ? result.items : [];
    return items.find((item) => {
      if (!item || typeof item !== "object") return false;
      const remote = typeof item.peerAccountId === "string" ? item.peerAccountId.trim() : "";
      const state = typeof item.state === "string" ? item.state.trim() : "";
      const peerInboxId = typeof item.peerInboxId === "string" ? item.peerInboxId.trim() : "";
      return remote === peerAccountId
        && (state === "established" || state === "session_established")
        && Boolean(peerInboxId);
    });
  }, CHAT_TIMEOUT_MS, label);
}

async function waitForDirectThread(chat, peerAccountId, label) {
  const thread = await waitFor(async () => {
    const result = await chat.bus.call("threads", "list", { limit: 50 });
    const threads = result && Array.isArray(result.threads) ? result.threads : [];
    return threads.find((item) => {
      if (!item || typeof item !== "object") return false;
      const peer = typeof item.peerAccountId === "string" ? item.peerAccountId.trim() : "";
      const peerInboxId = typeof item.peerInboxId === "string" ? item.peerInboxId.trim() : "";
      return peer === peerAccountId && peerInboxId && item.threadId;
    });
  }, CHAT_TIMEOUT_MS, label);
  return thread.threadId;
}

async function waitForMessageText(chat, threadId, text, label) {
  const msg = await waitFor(async () => {
    const result = await chat.bus.call("thread.messages", "list", { threadId, limit: 50 });
    const items = result && Array.isArray(result.items) ? result.items : [];
    return items.find((m) => {
      if (!m || typeof m !== "object") return false;
      if (m.text === text) return true;
      return m.payload && typeof m.payload === "object" && m.payload.text === text;
    });
  }, CHAT_TIMEOUT_MS, label);
  return msg;
}

test("live local mesh: a DELEGATED device invites a primary peer — V2 record resolves, X3DH completes, messages flow", { skip: SKIP ? "set RUN_LOCAL_MESH_E2E=1 and REZ_PG_TEST_URL to run" : false, timeout: 120_000 }, async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "rez-local-mesh-delegated-"));
  const rPort = await getFreePort();
  const started = [];

  await withAdminPg(PG_URL, async (pool) => {
    await pool.query("DROP SCHEMA IF EXISTS " + SCHEMA + " CASCADE");
    await pool.query("CREATE SCHEMA " + SCHEMA);
  });

  try {
    const relayApp = await startRezNode(relayOnlyConfig({
      dataDir: path.join(tmp, "relay"), listenPort: rPort,
      knownRelays: [],
    }));
    started.push(relayApp);
    const relayKeyId = relayApp.runtime.getIdentity().relayKeyId;

    // The ONE pg home. Alice keeps her own account on it alongside Bob's — the
    // hosted base case (many accounts, one home).
    const home = await startPgHome({ tmp, entryRelayKeyId: relayKeyId, entryRelayPort: rPort });
    started.push({ nodeApp: home.nodeApp });

    // Alice: an unchanged PRIMARY leaf. Bob: the DELEGATED leaf — his account
    // private key was zeroed inside makeDelegatedIdentity BEFORE this boot.
    const alice = await startChatLeaf({ tmp, label: "alice", wsUrl: home.wsUrl });
    started.push(alice);
    const bobDelegation = makeDelegatedIdentity();
    const bob = await startChatLeaf({
      tmp,
      label: "bob",
      wsUrl: home.wsUrl,
      expectedChatServerIdentity: bobDelegation.chatServerIdentity,
      deviceKey: bobDelegation.deviceKey,
    });
    started.push(bob);

    // Bob's stack booted delegated: cert-mode PeerLinkService, delegated row,
    // C-claimed inbox — and his live WS session authenticated with C + chain
    // (chatServer.start() resolves only after session auth).
    assert.equal(bob.accountId, bobDelegation.accountId, "Bob's chat server runs AS the account B");
    assert.equal(bob.bootstrapped.peerLinkService.hasAdminRoot, false);
    assert.equal(bob.bootstrapped.identity.hasAdminRoot, false);
    assert.equal(bob.bootstrapped.identity.privateKeyB64, "");
    assert.equal(
      bob.bootstrapped.inboxClaimant.claimantPublicKeyB64,
      bobDelegation.deviceKey.deviceKeyPair.publicKeyB64,
      "the device key C claims Bob's inbox",
    );

    await sleep(4_000);

    // --- BOB (delegated) creates the invite ---
    const invite = await bob.chat.bus.call("invite", "create", {
      kind: "direct", maxUses: 1, creatorDisplayName: "Bob",
    });
    assert.ok(invite.inviteCode, "the delegated device creates an invite code");

    // The stored envelope is C-signed under the chain; the durable record is a
    // DurableRecordV2 owned by B and signed by C — this is what just went onto
    // the REAL overlay.
    const stored = await bob.bootstrapped.peerLinkService.getStoredInviteEnvelope(bob.accountId, invite.inviteId);
    assert.equal(stored.envelope.signerRef.keyId, "invite-ed25519-delegated-v1");
    assert.equal(stored.envelope.signerRef.signerPublicKeyB64, bobDelegation.deviceKey.deviceKeyPair.publicKeyB64);
    assert.equal(Array.isArray(stored.envelope.certChain) && stored.envelope.certChain.length, 1);

    // --- ALICE (primary) accepts by code: the V2 record resolves across the mesh ---
    const accepted = await alice.chat.bus.call("invite", "accept", {
      inviteCode: invite.inviteCode, acceptorDisplayName: "Alice",
    });
    assert.equal(accepted.peerAccountId, bob.accountId, "Alice's accept resolves Bob's ACCOUNT identity (B)");
    assert.ok(accepted.threadId, "Alice's accept creates a thread");

    await waitForPeerLinkReady(bob.chat, alice.accountId, "Bob peer-link to Alice ready");
    const bobThreadId = await waitForDirectThread(bob.chat, alice.accountId, "Bob direct thread to Alice");
    const aliceThreadId = accepted.threadId;

    // --- Bob (delegated) → Alice ---
    const b2a = "delegated bob→alice over the real local mesh " + Date.now();
    await bob.chat.bus.call("message", "send", {
      threadId: bobThreadId, messageId: "b2a_" + Date.now(),
      payload: { kind: "rez.chat.message.v1", text: b2a },
    });
    const gotByAlice = await waitForMessageText(alice.chat, aliceThreadId, b2a, "Alice receives the delegated device's message decrypted");
    assert.equal(gotByAlice.senderAccountId, bob.accountId, "delivered message credits the ACCOUNT, not the device");

    // --- Alice → Bob (delegated) ---
    const a2b = "alice→delegated bob over the real local mesh " + Date.now();
    await alice.chat.bus.call("message", "send", {
      threadId: aliceThreadId, messageId: "a2b_" + Date.now(),
      payload: { kind: "rez.chat.message.v1", text: a2b },
    });
    const gotByBob = await waitForMessageText(bob.chat, bobThreadId, a2b, "the delegated device receives Alice's message decrypted");
    assert.equal(gotByBob.senderAccountId, alice.accountId, "delivered reply credits Alice");

    // The production throwing signer never fired implicitly — and if anything
    // above had reached for B's key, the zeroed bytes would have failed the
    // signature. Prove the guard is armed:
    await assert.rejects(
      () => bob.bootstrapped.peerLinkService.signer.sign(new Uint8Array([1])),
      /delegated and holds no account root key/,
    );
  } finally {
    for (const app of started.reverse()) {
      if (app && app.chat) await stopLeaf(app);
      else if (app && typeof app.stop === "function") await app.stop().catch(() => {});
      else if (app && app.nodeApp) await stopLeaf(app);
    }
    await withAdminPg(PG_URL, async (pool) => {
      await pool.query("DROP SCHEMA IF EXISTS " + SCHEMA + " CASCADE");
    }).catch((err) => {
      console.error("[delegated-invite e2e] schema teardown failed", err && err.message ? err.message : err);
    });
    await fs.rm(tmp, { recursive: true, force: true }).catch((err) => {
      console.error("[delegated-invite e2e] tmp cleanup failed", err && err.message ? err.message : err);
    });
  }
});
