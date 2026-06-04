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
 * LIVE DO-relay GROUP e2e — fully un-mocked, real DigitalOcean relays.
 *
 * Reproduces the desktop two-node failure observed 2026-06-04: a creator makes
 * a group and invites a peer; the peer accepts; then the peer sends a group
 * message WHILE THE INVITER IS OFFLINE; when the inviter comes back the message
 * must arrive via inbox catch-up and BOTH rosters must show two named members.
 * The screenshot symptom was: acceptor sent "yo" while the inviter was offline,
 * the inviter relogged in and saw "No messages yet" with a single raw rez:id in
 * the members overlay.
 *
 * This is the offline-deposit → catch-up path the serialized InboundDepositPipeline
 * fix targets, plus the membership-displayName persistence fix. The companion
 * e2e.internet.chat covers the all-online DM path. Mirrors its DO relay loading,
 * node bootstrap, and real chat-server wiring. Gated behind RUN_INTERNET_E2E=1.
 */

const RUN_LIVE = String(process.env.RUN_INTERNET_E2E || "").trim() === "1";
const ASSERT_ONION_PROOF = String(process.env.REZ_E2E_ASSERT_ONION_PROOF || "").trim() === "1";
const SETTLE_MS = Number.parseInt(String(process.env.REZ_CHAT_E2E_SETTLE_MS || "10000"), 10);
const CHAT_TIMEOUT_MS = Number.parseInt(String(process.env.REZ_CHAT_E2E_TIMEOUT_MS || "60000"), 10);

const silentLogger = {
  log() {},
  info() {},
  warn() {},
  error() {},
  debug() {},
};

test("live DO relay mesh: acceptor's group message sent while the inviter is OFFLINE arrives on catch-up, roster stays named", {
  skip: RUN_LIVE ? false : "set RUN_INTERNET_E2E=1 to run live DigitalOcean chat e2e",
  timeout: 240000,
}, async () => {
  const knownRelays = loadKnownRelays();
  assert.ok(knownRelays.length >= 1, "expected at least one known relay");

  const routePolicy = ASSERT_ONION_PROOF
    ? { defaultHops: 3, forceOnionRouting: true }
    : { defaultHops: 1, forceOnionRouting: false };

  let alice = null; // creator / inviter (goes offline)
  let bob = null;   // acceptor (sends "yo" while Alice is offline)
  try {
    alice = await startChatNode({ label: "alice", knownRelays, routePolicy });
    bob = await startChatNode({ label: "bob", knownRelays, routePolicy });

    await sleep(SETTLE_MS);

    // --- 1. Alice creates a group + GROUP invite; Bob accepts (both online) ---
    const nonce = "grp-live-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
    const groupTitle = "Live Group E2E " + nonce;
    const created = await alice.chat.bus.call("group", "create", { title: groupTitle });
    const groupId = created.groupId;
    const aliceThreadId = created.threadId;
    assert.ok(groupId, "Alice creates a group id");
    assert.ok(aliceThreadId, "Alice creates a group thread id");

    const invite = await alice.chat.bus.call("invite", "create", {
      kind: "group",
      groupId,
      title: groupTitle,
      maxUses: 1,
      creatorDisplayName: "Alice",
    });
    assert.ok(invite.inviteCode, "Alice creates a group invite code");

    const accepted = await bob.chat.bus.call("invite", "accept", {
      inviteCode: invite.inviteCode,
      acceptorDisplayName: "Bob",
    });
    assert.equal(accepted.groupId, groupId, "Bob's accept resolves the same group");
    const bobThreadId = accepted.groupThreadId;
    assert.ok(bobThreadId, "Bob's accept resolves the group thread id");

    // Peer-links establish both directions; Bob's member.join reaches Alice so
    // both rosters carry two named members (membership displayName + contact).
    await waitForPeerLinkReady(alice.chat, bob.accountId, CHAT_TIMEOUT_MS, "Alice peer-link to Bob ready");
    await waitForPeerLinkReady(bob.chat, alice.accountId, CHAT_TIMEOUT_MS, "Bob peer-link to Alice ready");

    await waitForGroupMember(alice.chat, groupId, bob.accountId, CHAT_TIMEOUT_MS, "Bob joins Alice's roster");
    const aliceRosterBefore = await listMembers(alice.chat, groupId);
    assert.equal(aliceRosterBefore.length, 2, "Alice roster has two members before going offline");
    const aliceBobRow = aliceRosterBefore.find((m) => m.accountId === bob.accountId);
    const aliceSelfRow = aliceRosterBefore.find((m) => m.accountId === alice.accountId);
    assert.ok(aliceSelfRow, "Alice's own row present in her roster");
    assert.ok(aliceBobRow, "Bob's row present in Alice's roster");
    assert.equal(aliceBobRow.displayName, "Bob", "Bob's display name persisted on Alice's membership row");
    assert.equal(aliceSelfRow.role, "creator", "Alice is the group creator");

    // --- 2. Alice goes OFFLINE (stop chat server + node, keep storage) ---
    const aliceDataDir = alice.dataDir;
    const aliceTmpDir = alice.tmpDir;
    const aliceAccountId = alice.accountId;
    await stopChatNode(alice, { keepTmp: true });
    alice = null;

    // Give the relay a moment to register Alice's inbox as offline.
    await sleep(3_000);

    // --- 3. Bob sends a group message while Alice is offline (the "yo") ---
    const b2a = "yo " + nonce;
    const bobSent = await bob.chat.bus.call("message", "send", {
      threadId: bobThreadId,
      messageId: "b2a_" + nonce,
      payload: { kind: "rez.chat.message.v1", text: b2a },
    });
    assert.equal(bobSent.threadId, bobThreadId);

    // Let the deposit settle into Alice's relay inbox store.
    await sleep(3_000);

    // --- 4. Alice comes back ONLINE (restart against the same storage) ---
    alice = await startChatNode({
      label: "alice",
      knownRelays,
      routePolicy,
      dataDir: aliceDataDir,
      tmpDir: aliceTmpDir,
    });
    assert.equal(alice.accountId, aliceAccountId, "Alice keeps her identity across relogin");

    // Let the node reconnect to the relay so InboxCatchupService can drain.
    await sleep(SETTLE_MS);

    // The offline "yo" must arrive via catch-up (the core symptom).
    const gotByAlice = await waitForMessageText(alice.chat, aliceThreadId, b2a, CHAT_TIMEOUT_MS, "Alice catches up Bob's offline group message");
    assert.equal(gotByAlice.senderAccountId, bob.accountId, "caught-up group message credits Bob");

    // Roster survives relogin with both members still named.
    const aliceRosterAfter = await listMembers(alice.chat, groupId);
    assert.equal(aliceRosterAfter.length, 2, "Alice roster still has two members after relogin");
    const bobRowAfter = aliceRosterAfter.find((m) => m.accountId === bob.accountId);
    assert.ok(bobRowAfter, "Bob still present in Alice's roster after relogin");
    assert.equal(bobRowAfter.displayName, "Bob", "Bob's name survives relogin on Alice's roster");

    // --- 5. Alice → Bob reply still routes after relogin ---
    const a2b = "hey back " + nonce;
    await alice.chat.bus.call("message", "send", {
      threadId: aliceThreadId,
      messageId: "a2b_" + nonce,
      payload: { kind: "rez.chat.message.v1", text: a2b },
    });
    const gotByBob = await waitForMessageText(bob.chat, bobThreadId, a2b, CHAT_TIMEOUT_MS, "Bob receives Alice's reply after her relogin");
    assert.equal(gotByBob.senderAccountId, alice.accountId, "delivered reply credits Alice");
  } finally {
    await stopChatNode(bob);
    await stopChatNode(alice);
  }
});

async function startChatNode({ label, knownRelays, routePolicy, dataDir = null, tmpDir = null } = {}) {
  const resolvedTmpDir = tmpDir || (await fs.mkdtemp(path.join(os.tmpdir(), "rez-chat-live-group-" + label + "-")));
  const resolvedDataDir = dataDir || path.join(resolvedTmpDir, "node-data");
  await fs.mkdir(resolvedDataDir, { recursive: true });

  const wsPort = await getFreePort();
  const wsPath = "/ws";
  const config = {
    node: {
      ws: { host: "127.0.0.1", port: wsPort, path: wsPath },
      storage: { dataDir: resolvedDataDir },
      network: { participateInRouting: true, knownRelays },
      mesh: {
        enabled: true,
        mode: "seed-only",
        seeds: [],
        minPeers: 1,
        maxPeers: 5,
        policy: routePolicy,
      },
      relay: {
        listenHost: "127.0.0.1",
        listenPort: 0,
      },
    },
  };

  const nodeApp = await startRezNode(config);
  const wsUrl = "ws://127.0.0.1:" + wsPort + wsPath;
  const bootstrapped = await bootstrapChatServer({
    nodeDataDir: resolvedDataDir,
    wsUrl,
    logger: silentLogger,
  });
  await bootstrapped.chatServer.start();

  return {
    label,
    tmpDir: resolvedTmpDir,
    dataDir: resolvedDataDir,
    nodeApp,
    chat: bootstrapped.chatServer,
    accountId: bootstrapped.ownerAccountId,
    wsUrl,
  };
}

async function stopChatNode(app, { keepTmp = false } = {}) {
  if (!app) return;
  if (app.chat && typeof app.chat.stop === "function") {
    await app.chat.stop().catch(() => {});
  }
  if (app.nodeApp && typeof app.nodeApp.stop === "function") {
    await app.nodeApp.stop().catch(() => {});
  }
  if (app.tmpDir && !keepTmp) {
    await fs.rm(app.tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

// The live DO relays are the production knownRelays baked into the default
// rez config (r1/r2/r3.rezprotocol.io:8443, TLS) — the exact set the shipped
// app dials. Use them directly so this test needs no relay-info.json overlay.
function loadKnownRelays() {
  const cfg = createDefaultRezConfig({ dataDir: path.join(os.tmpdir(), "rez-relay-cfg-ignored") });
  const relays = cfg && cfg.node && cfg.node.network && Array.isArray(cfg.node.network.knownRelays)
    ? cfg.node.network.knownRelays
    : [];
  return relays.map((relay) => ({ ...relay }));
}

async function waitForPeerLinkReady(chat, peerAccountId, timeoutMs, label) {
  return waitFor(async () => {
    const result = await chat.bus.call("peer-links", "list", {});
    const items = result && Array.isArray(result.items) ? result.items : [];
    return items.find((item) => {
      if (!item || typeof item !== "object") return false;
      const remote = typeof item.peerAccountId === "string" ? item.peerAccountId.trim() : "";
      const state = typeof item.state === "string" ? item.state.trim() : "";
      const sessionState = typeof item.sessionState === "string" ? item.sessionState.trim() : "";
      const peerInboxId = typeof item.peerInboxId === "string" ? item.peerInboxId.trim() : "";
      return remote === peerAccountId
        && (state === "established" || state === "session_established")
        && (sessionState === "" || sessionState === "active" || sessionState === "established" || sessionState === "session_established")
        && Boolean(peerInboxId);
    });
  }, timeoutMs, label);
}

async function listMembers(chat, groupId) {
  const result = await chat.bus.call("group.members", "list", { groupId });
  return result && Array.isArray(result.items) ? result.items : [];
}

async function waitForGroupMember(chat, groupId, accountId, timeoutMs, label) {
  return waitFor(async () => {
    const items = await listMembers(chat, groupId);
    return items.find((m) => {
      if (!m || typeof m !== "object") return false;
      return String(m.accountId || "").trim() === accountId && m.state === "active";
    });
  }, timeoutMs, label);
}

async function waitForMessageText(chat, threadId, text, timeoutMs, label) {
  return waitFor(async () => {
    const result = await chat.bus.call("thread.messages", "list", { threadId, limit: 50 });
    const items = result && Array.isArray(result.items) ? result.items : [];
    return items.find((message) => {
      if (!message || typeof message !== "object") return false;
      if (message.text === text) return true;
      return message.payload && typeof message.payload === "object" && message.payload.text === text;
    });
  }, timeoutMs, label || "message delivery");
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
    await sleep(500);
  }
  const suffix = lastError && lastError.message ? ": " + lastError.message : "";
  throw new Error("Timed out waiting for " + label + suffix);
}

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      server.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
