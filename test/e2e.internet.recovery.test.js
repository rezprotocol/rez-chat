// Live DO-relay validation of recovery-via-reinvite. Boots two real chat servers
// (alice + bob) against the production relays, establishes a DM, then:
//   T1 forces a GENUINE desync (corrupts alice's stored session so she can no
//      longer decrypt bob) and asserts the ORGANIC detector heals the link by
//      re-inviting — a fresh bob->alice message arrives with no manual steps.
//   T2 forces GLARE (both sides trigger recovery at once) and asserts the link
//      converges on a single matched pair and messages flow both directions.
//
// Run: RUN_INTERNET_E2E=1 node --test test/e2e.internet.recovery.test.js
// (the runner needs raw network egress to r1/r2/r3 — use dangerouslyDisableSandbox).

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { startRezNode } from "@rezprotocol/node";
import { bootstrapChatServer } from "../src/server/index.js";
import { createDefaultRezConfig } from "../src/server/config/defaultRezConfig.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");

const RUN_LIVE = String(process.env.RUN_INTERNET_E2E || "").trim() === "1";
const SETTLE_MS = Number.parseInt(String(process.env.REZ_CHAT_E2E_SETTLE_MS || "10000"), 10);
const HEAL_TIMEOUT_MS = Number.parseInt(String(process.env.REZ_CHAT_E2E_HEAL_MS || "90000"), 10);

function makeLogger(label) {
  return {
    log() {}, info() {}, debug() {},
    warn(...a) { if (process.env.REZ_E2E_LOG) console.warn("[" + label + "]", ...a); },
    error(...a) { if (process.env.REZ_E2E_LOG) console.error("[" + label + "]", ...a); },
  };
}

test("live: a desynced DM link self-heals by re-invite and resumes delivery", {
  skip: RUN_LIVE ? false : "set RUN_INTERNET_E2E=1 to run live DigitalOcean recovery e2e",
  timeout: 180000,
}, async () => {
  const knownRelays = loadKnownRelays();
  assert.ok(knownRelays.length >= 1, "expected at least one known relay");

  let alice = null;
  let bob = null;
  try {
    alice = await startChatNode("alice", knownRelays);
    bob = await startChatNode("bob", knownRelays);
    await sleep(SETTLE_MS);

    const { aliceThreadId, bobThreadId } = await establishDirect(alice, bob);

    // Sanity: the link delivers a baseline message before we break it.
    await sendChat(bob, bobThreadId, "baseline pre-desync");
    await waitForMessageText(alice.chat, aliceThreadId, "baseline pre-desync", HEAL_TIMEOUT_MS);

    // FORCE A GENUINE DESYNC: wipe the ratchet contexts in alice's stored session
    // for bob (keep the session RECORD active, so it's a real "usable session that
    // can't decrypt" — exactly the live symptom). Bob is untouched, so bob keeps
    // sending on a session alice can no longer read.
    await corruptStoredSession(alice, bob.accountId);

    // Drive bob->alice traffic. Each undecryptable arrival is a recovery candidate;
    // once the miss threshold trips, alice auto-re-invites bob, bob accepts
    // (forceReestablish), the link re-establishes, and a POST-recovery bob message
    // decrypts. (Messages sent into the dead session before recovery are orphaned —
    // expected; the point is the link HEALS and new traffic flows.) We loop sending
    // fresh messages until one is delivered or we time out.
    const deadline = Date.now() + HEAL_TIMEOUT_MS;
    let healed = false;
    let i = 0;
    while (Date.now() < deadline) {
      i += 1;
      const nonce = "post-recovery-" + i + "-" + Math.random().toString(36).slice(2, 6);
      await sendChat(bob, bobThreadId, nonce);
      const got = await pollMessageText(alice.chat, aliceThreadId, nonce, 4000);
      if (got) { healed = true; break; }
    }
    assert.ok(healed, "alice received a bob message after the link re-established (auto-recovery)");

    // And recovery is bidirectional: alice -> bob now works too.
    const back = "post-recovery-reply-" + Math.random().toString(36).slice(2, 6);
    await sendChat(alice, aliceThreadId, back);
    await waitForMessageText(bob.chat, bobThreadId, back, HEAL_TIMEOUT_MS);
  } finally {
    await stopChatNode(bob);
    await stopChatNode(alice);
  }
});

test("live: simultaneous recovery (glare) converges and delivers both directions", {
  skip: RUN_LIVE ? false : "set RUN_INTERNET_E2E=1 to run live DigitalOcean recovery e2e",
  timeout: 180000,
}, async () => {
  const knownRelays = loadKnownRelays();
  let alice = null;
  let bob = null;
  try {
    alice = await startChatNode("alice", knownRelays);
    bob = await startChatNode("bob", knownRelays);
    await sleep(SETTLE_MS);

    const { aliceThreadId, bobThreadId } = await establishDirect(alice, bob);

    // Both sides re-invite at once — the accept-side glare tiebreak must keep a
    // single matched pair (the pre-fix failure mode was two mismatched halves).
    triggerRecovery(alice, bob.accountId);
    triggerRecovery(bob, alice.accountId);

    // After convergence, both directions deliver.
    const a2b = "glare-a2b-" + Math.random().toString(36).slice(2, 6);
    const b2a = "glare-b2a-" + Math.random().toString(36).slice(2, 6);
    await deliverEventually(alice, aliceThreadId, bob, bobThreadId, a2b, HEAL_TIMEOUT_MS);
    await deliverEventually(bob, bobThreadId, alice, aliceThreadId, b2a, HEAL_TIMEOUT_MS);
  } finally {
    await stopChatNode(bob);
    await stopChatNode(alice);
  }
});

// --- scenario helpers ---

async function establishDirect(alice, bob) {
  const invite = await alice.chat.bus.call("invite", "create", { kind: "direct", maxUses: 1, creatorDisplayName: "Alice" });
  const accepted = await bob.chat.bus.call("invite", "accept", { inviteCode: invite.inviteCode, acceptorDisplayName: "Bob" });
  assert.equal(accepted.peerAccountId, alice.accountId);
  const bobThreadId = accepted.threadId;
  await waitForPeerLinkReady(alice.chat, bob.accountId, HEAL_TIMEOUT_MS, "Alice peer link to Bob");
  const aliceThreadId = await waitForDirectThread(alice.chat, bob.accountId, HEAL_TIMEOUT_MS, "Alice direct thread");
  await waitForThread(bob.chat, bobThreadId, HEAL_TIMEOUT_MS, "Bob accepted thread");
  return { aliceThreadId, bobThreadId };
}

async function sendChat(node, threadId, text) {
  const nonce = "client_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
  await node.chat.bus.call("message", "send", {
    threadId,
    messageId: nonce,
    payload: { kind: "rez.chat.message.v1", text },
  });
}

function triggerRecovery(node, peerAccountId) {
  const svc = node.chat.bus.services && node.chat.bus.services.peerLinkProtocol;
  assert.ok(svc && typeof svc._triggerRecoveryInvite === "function", "peerLinkProtocol._triggerRecoveryInvite available");
  svc._triggerRecoveryInvite({ peerAccountId });
}

// Replace the ratchet contexts in node's stored session for `peerAccountId` with
// an empty set, keeping the record active. Decrypt then misses on every incoming
// packet (no sid match) — a genuine "usable session that can't decrypt".
async function corruptStoredSession(node, peerAccountId) {
  const peerLinks = node.chat.bus.runtime && node.chat.bus.runtime.peerLinks;
  assert.ok(peerLinks, "chat runtime exposes peerLinks");
  const list = await peerLinks.listPeerLinks({ ownerAccountId: node.accountId });
  const link = (list.items || []).find((it) => it && it.peerAccountId === peerAccountId);
  assert.ok(link, "node holds a peer-link to the peer to corrupt");
  const sessions = peerLinks.peerLinkStorage.sessions;
  const sess = await sessions.getByPeerLinkId(node.accountId, link.peerLinkId);
  assert.ok(sess && sess.ratchetSnapshot, "peer-link has a stored session to corrupt");
  const snapshot = JSON.parse(JSON.stringify(sess.ratchetSnapshot));
  snapshot.sessions = {};
  await sessions.put({ ...sess, ratchetSnapshot: snapshot, status: "active" });
}

async function deliverEventually(fromNode, fromThreadId, toNode, toThreadId, text, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sendChat(fromNode, fromThreadId, text);
    const got = await pollMessageText(toNode.chat, toThreadId, text, 4000);
    if (got) return;
  }
  throw new Error("message never delivered after recovery: " + text);
}

// --- node lifecycle (mirrors e2e.internet.chat.test.js) ---

async function startChatNode(label, knownRelays) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "rez-chat-rec-" + label + "-"));
  const dataDir = path.join(tmpDir, "node-data");
  await fs.mkdir(dataDir, { recursive: true });
  const wsPort = await getFreePort();
  const config = {
    node: {
      ws: { host: "127.0.0.1", port: wsPort, path: "/ws" },
      storage: { dataDir },
      network: { participateInRouting: true, knownRelays },
      mesh: { enabled: true, mode: "seed-only", seeds: [], minPeers: 1, maxPeers: 5, policy: { defaultHops: 1, forceOnionRouting: false } },
      relay: { listenHost: "127.0.0.1", listenPort: 0 },
    },
  };
  const nodeApp = await startRezNode(config);
  const wsUrl = "ws://127.0.0.1:" + wsPort + "/ws";
  const bootstrapped = await bootstrapChatServer({ nodeDataDir: dataDir, wsUrl, logger: makeLogger(label) });
  await bootstrapped.chatServer.start();
  return { label, tmpDir, nodeApp, chat: bootstrapped.chatServer, accountId: bootstrapped.ownerAccountId, wsUrl };
}

async function stopChatNode(app) {
  if (!app) return;
  if (app.chat && typeof app.chat.stop === "function") await app.chat.stop().catch(() => {});
  if (app.nodeApp && typeof app.nodeApp.stop === "function") await app.nodeApp.stop().catch(() => {});
  if (app.tmpDir) await fs.rm(app.tmpDir, { recursive: true, force: true }).catch(() => {});
}

function loadKnownRelays() {
  const cfg = createDefaultRezConfig({ dataDir: path.join(os.tmpdir(), "rez-relay-cfg-ignored") });
  const relays = cfg && cfg.node && cfg.node.network && Array.isArray(cfg.node.network.knownRelays) ? cfg.node.network.knownRelays : [];
  return relays.map((relay) => ({ ...relay }));
}

// --- polling helpers ---

async function waitForPeerLinkReady(chat, peerAccountId, timeoutMs, label) {
  return waitFor(async () => {
    const result = await chat.bus.call("peer-links", "list", {});
    const items = result && Array.isArray(result.items) ? result.items : [];
    return items.find((item) => {
      const remote = item && typeof item.peerAccountId === "string" ? item.peerAccountId.trim() : "";
      const state = item && typeof item.state === "string" ? item.state.trim() : "";
      const peerInboxId = item && typeof item.peerInboxId === "string" ? item.peerInboxId.trim() : "";
      return remote === peerAccountId && (state === "established" || state === "session_established") && Boolean(peerInboxId);
    });
  }, timeoutMs, label);
}

async function waitForDirectThread(chat, peerAccountId, timeoutMs, label) {
  const thread = await waitFor(async () => {
    const result = await chat.bus.call("threads", "list", { limit: 50 });
    const threads = result && Array.isArray(result.threads) ? result.threads : [];
    return threads.find((item) => {
      const peer = item && typeof item.peerAccountId === "string" ? item.peerAccountId.trim() : "";
      const peerInboxId = item && typeof item.peerInboxId === "string" ? item.peerInboxId.trim() : "";
      return peer === peerAccountId && peerInboxId && item.threadId;
    });
  }, timeoutMs, label);
  return thread.threadId;
}

async function waitForThread(chat, threadId, timeoutMs, label) {
  return waitFor(async () => {
    const result = await chat.bus.call("thread", "get", { threadId, limit: 20 });
    return result && result.thread ? result.thread : null;
  }, timeoutMs, label);
}

async function waitForMessageText(chat, threadId, text, timeoutMs) {
  return waitFor(() => pollMessageText(chat, threadId, text, 0), timeoutMs, "message delivery: " + text);
}

async function pollMessageText(chat, threadId, text, graceMs) {
  if (graceMs > 0) await sleep(graceMs);
  const result = await chat.bus.call("thread.messages", "list", { threadId, limit: 100 });
  const items = result && Array.isArray(result.items) ? result.items : [];
  return items.find((m) => m && (m.text === text || (m.payload && m.payload.text === text))) || null;
}

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try { const value = await fn(); if (value) return value; } catch (err) { lastError = err; }
    await sleep(500);
  }
  throw new Error("Timed out waiting for " + label + (lastError && lastError.message ? ": " + lastError.message : ""));
}

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

async function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
