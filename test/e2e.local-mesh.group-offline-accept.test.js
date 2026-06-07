import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { startRezNode } from "@rezprotocol/node";
import { bootstrapChatServer } from "../src/server/index.js";

/**
 * LIVE local-mesh GROUP OFFLINE-ACCEPT e2e — fully un-mocked, loopback only.
 *
 *   aliceChat → aliceNode ─┐
 *                          ├─ relayR
 *   bobChat   → bobNode  ──┘
 *
 * The real desktop failure (2026-06-06): the inviter is OFFLINE at the moment the
 * acceptor accepts the invite, so bob's X3DH HANDSHAKE is sent while alice is down
 * and buffers on the relay. When alice comes back she must drain that handshake on
 * catch-up and establish her responder session. The companion
 * e2e.local-mesh.group (both online) passes; the internet group test only sends the
 * MESSAGE offline (handshake happens online). This isolates the offline-handshake
 * path. Gated behind RUN_LOCAL_MESH_E2E=1.
 */

const RUN = process.env.RUN_LOCAL_MESH_E2E === "1";
const CHAT_TIMEOUT_MS = 30_000;

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

function relayOnlyConfig({ dataDir, listenPort, relayKeyId, knownRelays }) {
  return {
    node: {
      mode: "relay-only",
      storage: { dataDir },
      network: { knownRelays },
      mesh: { mode: "seed-only", seeds: [] },
      relay: { listenHost: "127.0.0.1", listenPort, advertisedHost: "127.0.0.1", relayKeyId },
    },
  };
}

async function startChatLeaf({ tmp, label, entryRelayKeyId, entryRelayPort }) {
  const dataDir = path.join(tmp, label);
  await fs.mkdir(dataDir, { recursive: true });
  const wsPort = await getFreePort();
  const wsPath = "/ws";
  const nodeApp = await startRezNode({
    node: {
      ws: { host: "127.0.0.1", port: wsPort, path: wsPath },
      storage: { dataDir },
      network: { participateInRouting: true, knownRelays: [knownRelay(entryRelayKeyId, entryRelayPort)] },
      mesh: { enabled: true, mode: "seed-only", seeds: [], minPeers: 1, maxPeers: 5 },
      relay: { listenHost: "127.0.0.1", listenPort: 0 },
    },
  });
  const wsUrl = "ws://127.0.0.1:" + wsPort + wsPath;
  const bootstrapped = await bootstrapChatServer({ nodeDataDir: dataDir, wsUrl, logger: silentLogger });
  await bootstrapped.chatServer.start();
  return { label, dataDir, entryRelayKeyId, entryRelayPort, nodeApp, chat: bootstrapped.chatServer, accountId: bootstrapped.ownerAccountId };
}

async function stopLeaf(app) {
  if (!app) return;
  if (app.chat && typeof app.chat.stop === "function") await app.chat.stop().catch(() => {});
  if (app.nodeApp && typeof app.nodeApp.stop === "function") await app.nodeApp.stop().catch(() => {});
}

async function restartLeaf(tmp, app) {
  await stopLeaf(app);
  return startChatLeaf({ tmp, label: app.label, entryRelayKeyId: app.entryRelayKeyId, entryRelayPort: app.entryRelayPort });
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

async function listMembers(chat, groupId) {
  const result = await chat.bus.call("group.members", "list", { groupId });
  return result && Array.isArray(result.items) ? result.items : [];
}

async function waitForGroupMember(chat, groupId, accountId, label) {
  return waitFor(async () => {
    const items = await listMembers(chat, groupId);
    return items.find((m) => m && String(m.accountId || "").trim() === accountId && m.state === "active");
  }, CHAT_TIMEOUT_MS, label);
}

async function waitForMessageText(chat, threadId, text, label) {
  return waitFor(async () => {
    const result = await chat.bus.call("thread.messages", "list", { threadId, limit: 50 });
    const items = result && Array.isArray(result.items) ? result.items : [];
    return items.find((m) => {
      if (!m || typeof m !== "object") return false;
      if (m.text === text) return true;
      return m.payload && typeof m.payload === "object" && m.payload.text === text;
    });
  }, CHAT_TIMEOUT_MS, label);
}

test("live local mesh group OFFLINE-ACCEPT: Bob accepts while Alice is offline; her handshake catch-up establishes the link", { skip: !RUN, timeout: 180_000 }, async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "rez-local-mesh-offline-accept-"));
  const rPort = await getFreePort();
  let relay = null;
  let alice = null;
  let bob = null;
  try {
    relay = await startRezNode(relayOnlyConfig({
      dataDir: path.join(tmp, "relay"), listenPort: rPort, relayKeyId: "relay-core-1", knownRelays: [],
    }));

    alice = await startChatLeaf({ tmp, label: "alice", entryRelayKeyId: "relay-core-1", entryRelayPort: rPort });
    bob = await startChatLeaf({ tmp, label: "bob", entryRelayKeyId: "relay-core-1", entryRelayPort: rPort });
    await sleep(4_000);

    // --- Alice (online) creates a group + a GROUP invite ---
    const nonce = String(Date.now());
    const created = await alice.chat.bus.call("group", "create", { title: "Offline Accept " + nonce });
    const groupId = created.groupId;
    const aliceThreadId = created.threadId;
    assert.ok(groupId, "Alice creates a group id");

    const invite = await alice.chat.bus.call("invite", "create", {
      kind: "group", groupId, title: "Offline Accept " + nonce, maxUses: 1, creatorDisplayName: "Alice",
    });
    assert.ok(invite.inviteCode, "Alice creates a group invite code");

    // --- Alice goes OFFLINE (node + chat-server down, storage kept) ---
    await stopLeaf(alice);
    alice = null;
    await sleep(2_000);

    // --- Bob accepts WHILE ALICE IS OFFLINE → his X3DH handshake buffers on the relay ---
    const accepted = await bob.chat.bus.call("invite", "accept", {
      inviteCode: invite.inviteCode, acceptorDisplayName: "Bob",
    });
    assert.equal(accepted.groupId, groupId, "Bob's accept resolves the same group");
    const bobThreadId = accepted.groupThreadId;

    // Bob also sends a message while Alice is still offline.
    const b2a = "yo " + nonce;
    await bob.chat.bus.call("message", "send", {
      threadId: bobThreadId, messageId: "b2a_" + nonce,
      payload: { kind: "rez.chat.message.v1", text: b2a },
    });
    await sleep(2_000);

    // --- Alice comes back ONLINE; her catch-up must drain Bob's buffered handshake ---
    alice = await restartLeaf(tmp, { label: "alice", entryRelayKeyId: "relay-core-1", entryRelayPort: rPort });
    await sleep(4_000);

    // THE REGRESSION ASSERTIONS: the offline handshake must establish Alice's side.
    await waitForPeerLinkReady(alice.chat, bob.accountId, "Alice peer-link to Bob established from offline handshake");
    await waitForGroupMember(alice.chat, groupId, bob.accountId, "Bob joins Alice's roster after offline accept");
    const gotByAlice = await waitForMessageText(alice.chat, aliceThreadId, b2a, "Alice receives Bob's offline message");
    assert.equal(gotByAlice.senderAccountId, bob.accountId, "delivered message credits Bob");
  } finally {
    if (bob) await stopLeaf(bob);
    if (alice) await stopLeaf(alice);
    if (relay && typeof relay.stop === "function") await relay.stop().catch(() => {});
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
});
