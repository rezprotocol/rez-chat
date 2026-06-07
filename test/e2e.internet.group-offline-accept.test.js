import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { startRezNode } from "@rezprotocol/node";
import { bootstrapChatServer } from "../src/server/index.js";
import { createDefaultRezConfig } from "../src/server/config/defaultRezConfig.js";

/**
 * LIVE DO-relay GROUP OFFLINE-ACCEPT e2e — real r1/r2/r3 relays, the exact
 * topology the desktop dials. Reproduces the 2026-06-06 desktop failure: the
 * inviter is OFFLINE (node + chat-server down) at the moment the acceptor accepts,
 * so the acceptor's X3DH HANDSHAKE is sent while the inviter's own node — the host
 * of her inbox — is down, buffering on a relay. When she returns, catch-up must
 * drain that handshake and establish her responder session.
 *
 * The companion e2e.internet.group only sends the MESSAGE offline (handshake while
 * both online) and passes; e2e.local-mesh.group-offline-accept passes on a single
 * dedicated relay. This one uses the multi-relay production mesh. Gated behind
 * RUN_INTERNET_E2E=1.
 */

const RUN_LIVE = String(process.env.RUN_INTERNET_E2E || "").trim() === "1";
const SETTLE_MS = Number.parseInt(String(process.env.REZ_CHAT_E2E_SETTLE_MS || "12000"), 10);
const CHAT_TIMEOUT_MS = Number.parseInt(String(process.env.REZ_CHAT_E2E_TIMEOUT_MS || "60000"), 10);

// Pass through only the high-signal trace lines so the diagnostic isn't drowned
// by [rez][e2ee] spam; everything routes through console with an owner prefix.
const TRACE_RE = /PLTRACE|InboxCatchupService|establishResponder|establishInitiator|E2EE decryption|decryptAnyPeer|No peer link/;
function traceLogger(label) {
  const pass = (args) => {
    const line = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
    if (TRACE_RE.test(line)) console.log("[" + label + "] " + line);
  };
  return { log: (...a) => pass(a), info: (...a) => pass(a), warn: (...a) => pass(a), error: (...a) => pass(a), debug() {} };
}

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

function loadKnownRelays() {
  const cfg = createDefaultRezConfig({ dataDir: path.join(os.tmpdir(), "rez-relay-cfg-ignored") });
  const relays = cfg && cfg.node && cfg.node.network && Array.isArray(cfg.node.network.knownRelays)
    ? cfg.node.network.knownRelays : [];
  return relays.map((relay) => ({ ...relay }));
}

async function startChatNode({ label, knownRelays, dataDir = null, tmpDir = null } = {}) {
  const resolvedTmpDir = tmpDir || (await fs.mkdtemp(path.join(os.tmpdir(), "rez-offaccept-" + label + "-")));
  const resolvedDataDir = dataDir || path.join(resolvedTmpDir, "node-data");
  await fs.mkdir(resolvedDataDir, { recursive: true });
  const wsPort = await getFreePort();
  const wsPath = "/ws";
  const nodeApp = await startRezNode({
    node: {
      ws: { host: "127.0.0.1", port: wsPort, path: wsPath },
      storage: { dataDir: resolvedDataDir },
      network: { participateInRouting: true, knownRelays },
      mesh: { enabled: true, mode: "seed-only", seeds: [], minPeers: 1, maxPeers: 5, policy: { defaultHops: 1, forceOnionRouting: false } },
      relay: { listenHost: "127.0.0.1", listenPort: 0 },
    },
  });
  const wsUrl = "ws://127.0.0.1:" + wsPort + wsPath;
  const bootstrapped = await bootstrapChatServer({ nodeDataDir: resolvedDataDir, wsUrl, logger: traceLogger(label) });
  await bootstrapped.chatServer.start();
  return { label, tmpDir: resolvedTmpDir, dataDir: resolvedDataDir, nodeApp, chat: bootstrapped.chatServer, accountId: bootstrapped.ownerAccountId };
}

async function stopChatNode(app, { keepTmp = false } = {}) {
  if (!app) return;
  if (app.chat && typeof app.chat.stop === "function") await app.chat.stop().catch(() => {});
  if (app.nodeApp && typeof app.nodeApp.stop === "function") await app.nodeApp.stop().catch(() => {});
  if (app.tmpDir && !keepTmp) await fs.rm(app.tmpDir, { recursive: true, force: true }).catch(() => {});
}

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try { const v = await fn(); if (v) return v; } catch (err) { lastError = err; }
    await sleep(500);
  }
  throw new Error("Timed out waiting for " + label + (lastError && lastError.message ? ": " + lastError.message : ""));
}

async function listMembers(chat, groupId) {
  const result = await chat.bus.call("group.members", "list", { groupId });
  return result && Array.isArray(result.items) ? result.items : [];
}

async function waitForMessageText(chat, threadId, text, timeoutMs, label) {
  return waitFor(async () => {
    const result = await chat.bus.call("thread.messages", "list", { threadId, limit: 50 });
    const items = result && Array.isArray(result.items) ? result.items : [];
    return items.find((m) => (m && (m.text === text || (m.payload && m.payload.text === text))));
  }, timeoutMs, label);
}

async function waitForPeerLinkReady(chat, peerAccountId, timeoutMs, label) {
  return waitFor(async () => {
    const result = await chat.bus.call("peer-links", "list", {});
    const items = result && Array.isArray(result.items) ? result.items : [];
    return items.find((item) => item && item.peerAccountId === peerAccountId
      && (item.state === "established" || item.state === "session_established")
      && typeof item.peerInboxId === "string" && item.peerInboxId.length > 0);
  }, timeoutMs, label);
}

test("live DO relay mesh: Bob accepts the invite while Alice is OFFLINE; her handshake catch-up establishes the link + delivers his message", {
  skip: RUN_LIVE ? false : "set RUN_INTERNET_E2E=1 to run live DigitalOcean chat e2e",
  timeout: 300000,
}, async () => {
  const knownRelays = loadKnownRelays();
  assert.ok(knownRelays.length >= 1, "expected at least one known relay");

  let alice = null;
  let bob = null;
  try {
    alice = await startChatNode({ label: "alice", knownRelays });
    bob = await startChatNode({ label: "bob", knownRelays });
    await sleep(SETTLE_MS);

    const nonce = "offaccept-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
    const created = await alice.chat.bus.call("group", "create", { title: "OffAccept " + nonce });
    const groupId = created.groupId;
    const aliceThreadId = created.threadId;
    const invite = await alice.chat.bus.call("invite", "create", {
      kind: "group", groupId, title: "OffAccept " + nonce, maxUses: 1, creatorDisplayName: "Alice",
    });
    assert.ok(invite.inviteCode, "Alice creates a group invite code");

    // --- Alice goes OFFLINE (node + chat-server down; storage kept) BEFORE accept ---
    const aliceDataDir = alice.dataDir;
    const aliceTmpDir = alice.tmpDir;
    const aliceAccountId = alice.accountId;
    await stopChatNode(alice, { keepTmp: true });
    alice = null;
    await sleep(4_000);

    // --- Bob accepts WHILE ALICE IS OFFLINE → his X3DH handshake buffers on a relay ---
    const accepted = await bob.chat.bus.call("invite", "accept", {
      inviteCode: invite.inviteCode, acceptorDisplayName: "Bob",
    });
    assert.equal(accepted.groupId, groupId, "Bob's accept resolves the same group");
    const bobThreadId = accepted.groupThreadId;

    const b2a = "yo " + nonce;
    await bob.chat.bus.call("message", "send", {
      threadId: bobThreadId, messageId: "b2a_" + nonce,
      payload: { kind: "rez.chat.message.v1", text: b2a },
    });
    await sleep(5_000);

    // --- Alice comes back ONLINE; catch-up must drain Bob's buffered handshake ---
    alice = await startChatNode({ label: "alice", knownRelays, dataDir: aliceDataDir, tmpDir: aliceTmpDir });
    assert.equal(alice.accountId, aliceAccountId, "Alice keeps her identity across relogin");
    await sleep(SETTLE_MS);

    await waitForPeerLinkReady(alice.chat, bob.accountId, CHAT_TIMEOUT_MS, "Alice peer-link established from offline handshake");
    const gotByAlice = await waitForMessageText(alice.chat, aliceThreadId, b2a, CHAT_TIMEOUT_MS, "Alice catches up Bob's offline-accept message");
    assert.equal(gotByAlice.senderAccountId, bob.accountId, "caught-up message credits Bob");
    const roster = await listMembers(alice.chat, groupId);
    assert.equal(roster.length, 2, "Alice roster has two members after offline accept");
  } finally {
    await stopChatNode(bob);
    await stopChatNode(alice);
  }
});
