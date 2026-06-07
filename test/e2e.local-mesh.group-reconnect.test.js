import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { startRezNode } from "@rezprotocol/node";
import { bootstrapChatServer } from "../src/server/index.js";

/**
 * LIVE local-mesh GROUP RECONNECT e2e — fully un-mocked, loopback only.
 *
 *   aliceChat → aliceNode ─┐
 *                          ├─ relayR
 *   bobChat   → bobNode  ──┘
 *
 * The companion e2e.local-mesh.group proves the steady-state both-online group
 * flow (it passes). This isolates the desktop two-node failure observed
 * 2026-06-06: after the group is established, ALICE RESTARTS (the "offline"
 * the user reported — closing/reopening the app). Her embedded node comes back
 * up and re-hosts her own inbox. Bob then sends a group message while Alice is
 * back online. The deposit routes to Alice's OWN node (the host of her inbox),
 * buffers in her relay-inbox, and the live onDeposit notification must reach her
 * reconnected chat-server session. The reported symptom: it does not — Bob's
 * message (and the peer-link/roster state behind it) never lands on Alice after
 * the reconnect, so Alice keeps seeing only her own messages.
 *
 * This is the self-hosted-inbox + reconnect path the steady-state test does NOT
 * cover (it never restarts Alice). Gated behind RUN_LOCAL_MESH_E2E=1.
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
  return { label, dataDir, wsUrl, entryRelayKeyId, entryRelayPort, nodeApp, chat: bootstrapped.chatServer, accountId: bootstrapped.ownerAccountId };
}

async function stopLeaf(app) {
  if (!app) return;
  if (app.chat && typeof app.chat.stop === "function") await app.chat.stop().catch(() => {});
  if (app.nodeApp && typeof app.nodeApp.stop === "function") await app.nodeApp.stop().catch(() => {});
}

// Restart ONLY the chat-server, keeping the long-lived embedded node up — this
// mirrors the desktop, where the node lives in the main process for the whole
// session while the chat-server's WS link to it can drop and reconnect (e.g. a
// renderer reload or a transient WS blip). The node's inbox host registration
// from the previous chat-server connection must be re-bound to the NEW socket.
async function restartChatOnly(app) {
  if (app.chat && typeof app.chat.stop === "function") await app.chat.stop().catch(() => {});
  const bootstrapped = await bootstrapChatServer({ nodeDataDir: app.dataDir, wsUrl: app.wsUrl, logger: silentLogger });
  await bootstrapped.chatServer.start();
  return { ...app, chat: bootstrapped.chatServer, accountId: bootstrapped.ownerAccountId };
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

test("live local mesh group RECONNECT: after Alice restarts, Bob's group message still reaches Alice", { skip: !RUN, timeout: 180_000 }, async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "rez-local-mesh-group-reconnect-"));
  const rPort = await getFreePort();
  const started = [];
  let relay = null;
  let alice = null;
  let bob = null;
  try {
    relay = await startRezNode(relayOnlyConfig({
      dataDir: path.join(tmp, "relay"), listenPort: rPort, relayKeyId: "relay-core-1", knownRelays: [],
    }));
    started.push(relay);

    alice = await startChatLeaf({ tmp, label: "alice", entryRelayKeyId: "relay-core-1", entryRelayPort: rPort });
    bob = await startChatLeaf({ tmp, label: "bob", entryRelayKeyId: "relay-core-1", entryRelayPort: rPort });

    await sleep(4_000);

    // --- Alice creates a group + a GROUP invite; Bob accepts (both online) ---
    const nonce = String(Date.now());
    const groupTitle = "Local Mesh Group Reconnect " + nonce;
    const created = await alice.chat.bus.call("group", "create", { title: groupTitle });
    const groupId = created.groupId;
    const aliceThreadId = created.threadId;
    assert.ok(groupId, "Alice creates a group id");

    const invite = await alice.chat.bus.call("invite", "create", {
      kind: "group", groupId, title: groupTitle, maxUses: 1, creatorDisplayName: "Alice",
    });
    assert.ok(invite.inviteCode, "Alice creates a group invite code");

    const accepted = await bob.chat.bus.call("invite", "accept", {
      inviteCode: invite.inviteCode, acceptorDisplayName: "Bob",
    });
    assert.equal(accepted.groupId, groupId, "Bob's accept resolves the same group");
    const bobThreadId = accepted.groupThreadId;

    await waitForPeerLinkReady(alice.chat, bob.accountId, "Alice peer-link to Bob ready (pre-restart)");
    await waitForPeerLinkReady(bob.chat, alice.accountId, "Bob peer-link to Alice ready (pre-restart)");
    await waitForGroupMember(alice.chat, groupId, bob.accountId, "Bob joins Alice's roster (pre-restart)");
    await waitForGroupMember(bob.chat, groupId, alice.accountId, "Alice in Bob's roster (pre-restart)");

    // --- Alice's CHAT-SERVER reconnects to her still-running node (renderer
    // reload / WS blip). Her node — the host of her own inbox — stays up. ---
    // Her group thread id is persisted, so it survives the reconnect unchanged.
    alice = await restartChatOnly(alice);
    await sleep(4_000);

    // Peer-link should still be established after the chat-server reconnect.
    await waitForPeerLinkReady(alice.chat, bob.accountId, "Alice peer-link to Bob ready (post-reconnect)");

    // --- Bob sends a group message while Alice is back online ---
    const b2a = "yo " + nonce;
    const bobSent = await bob.chat.bus.call("message", "send", {
      threadId: bobThreadId, messageId: "b2a_" + nonce,
      payload: { kind: "rez.chat.message.v1", text: b2a },
    });
    assert.equal(bobSent.threadId, bobThreadId);
    await waitForMessageText(bob.chat, bobThreadId, b2a, "Bob sees his own message locally");

    // THE REGRESSION ASSERTION: Bob's post-reconnect group message must land on Alice.
    const gotByAlice = await waitForMessageText(alice.chat, aliceThreadId, b2a, "Alice receives Bob's group message AFTER her restart");
    assert.equal(gotByAlice.senderAccountId, bob.accountId, "delivered group message credits Bob");
  } finally {
    if (bob) await stopLeaf(bob);
    if (alice) await stopLeaf(alice);
    if (relay && typeof relay.stop === "function") await relay.stop().catch(() => {});
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
});
