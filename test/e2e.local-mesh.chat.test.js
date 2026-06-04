import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { startRezNode } from "@rezprotocol/node";
import { bootstrapChatServer } from "../src/server/index.js";

/**
 * LIVE local-mesh CHAT e2e — fully un-mocked, loopback only.
 *
 *   aliceChat → aliceNode ─┐
 *                          ├─ relayR ─┐
 *   bobChat   → bobNode  ──┘          │
 *
 * Two REAL chat-servers, each over a REAL WebSocket uplink to its own REAL
 * rez-node, both peered to a REAL shared relay over REAL TCP (no DigitalOcean,
 * no mocks, no fake sockets). This is the ONLY loopback test that drives the
 * full production SEND path — the one the seal→dispatch migration changed —
 * end to end:
 *
 *   message.send → ServerMessagesService → sdk.sealForPeer (encrypt + resolve
 *   inbox + cap) → sdk.mesh.dispatch(object, inbox-address) → MAILBOX_DEPOSIT →
 *   aliceNode → relayR routes to bob's registered inbox → bobNode → drain →
 *   decrypt → bob sees the plaintext (and the reverse).
 *
 * Topology note: both leaves share ONE relay so inbox delivery resolves on a
 * local RouteTable entry — this isolates the changed send/seal path from
 * cross-relay route PROPAGATION (descriptor/route-gossip between relays), which
 * the migration did not touch and which requires production relay wiring (it's
 * covered by e2e.internet.chat against real relays). Gated behind
 * RUN_LOCAL_MESH_E2E=1 (binds real loopback ports + waits on real mesh form).
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
  return { label, nodeApp, chat: bootstrapped.chatServer, accountId: bootstrapped.ownerAccountId };
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

test("live local mesh chat: invite + bidirectional message delivery over a shared relay", { skip: !RUN, timeout: 120_000 }, async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "rez-local-mesh-chat-"));
  const rPort = await getFreePort();
  const started = [];
  try {
    // One real relay over TCP that both stacks peer.
    started.push(await startRezNode(relayOnlyConfig({
      dataDir: path.join(tmp, "relay"), listenPort: rPort, relayKeyId: "relay-core-1",
      knownRelays: [],
    })));

    // Both stacks peer the same relay, so each registers its inbox there and
    // the relay routes deposits between them off its local RouteTable.
    const alice = await startChatLeaf({ tmp, label: "alice", entryRelayKeyId: "relay-core-1", entryRelayPort: rPort });
    started.push(alice);
    const bob = await startChatLeaf({ tmp, label: "bob", entryRelayKeyId: "relay-core-1", entryRelayPort: rPort });
    started.push(bob);

    // Let the mesh form (relay core peering + each leaf↔relay uplink + WS auth).
    await sleep(4_000);

    // --- Invite (durable record resolves across the core, inviter online) ---
    const invite = await alice.chat.bus.call("invite", "create", {
      kind: "direct", maxUses: 1, creatorDisplayName: "Alice",
    });
    assert.ok(invite.inviteCode, "Alice creates an invite code");

    const accepted = await bob.chat.bus.call("invite", "accept", {
      inviteCode: invite.inviteCode, acceptorDisplayName: "Bob",
    });
    assert.equal(accepted.peerAccountId, alice.accountId, "Bob's accept resolves Alice's account");
    assert.ok(accepted.threadId, "Bob's accept creates a thread");

    // Both sides reach an established peer-link with a resolved inbox binding.
    await waitForPeerLinkReady(alice.chat, bob.accountId, "Alice peer-link to Bob ready");
    const aliceThreadId = await waitForDirectThread(alice.chat, bob.accountId, "Alice direct thread to Bob");
    const bobThreadId = accepted.threadId;

    // --- Alice → Bob: real seal→dispatch→deposit→cross-relay→deliver→decrypt ---
    const a2b = "alice→bob over the real local mesh " + Date.now();
    const sent = await alice.chat.bus.call("message", "send", {
      threadId: aliceThreadId, messageId: "a2b_" + Date.now(),
      payload: { kind: "rez.chat.message.v1", text: a2b },
    });
    assert.equal(sent.threadId, aliceThreadId);
    const gotByBob = await waitForMessageText(bob.chat, bobThreadId, a2b, "Bob receives Alice's message decrypted");
    assert.equal(gotByBob.senderAccountId, alice.accountId, "delivered message credits Alice");

    // --- Bob → Alice: prove the reverse direction routes + decrypts too ---
    const b2a = "bob→alice over the real local mesh " + Date.now();
    await bob.chat.bus.call("message", "send", {
      threadId: bobThreadId, messageId: "b2a_" + Date.now(),
      payload: { kind: "rez.chat.message.v1", text: b2a },
    });
    const gotByAlice = await waitForMessageText(alice.chat, aliceThreadId, b2a, "Alice receives Bob's message decrypted");
    assert.equal(gotByAlice.senderAccountId, bob.accountId, "delivered reply credits Bob");
  } finally {
    for (const app of started.reverse()) {
      if (app && app.chat) await stopLeaf(app);
      else if (app && typeof app.stop === "function") await app.stop().catch(() => {});
    }
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
});
