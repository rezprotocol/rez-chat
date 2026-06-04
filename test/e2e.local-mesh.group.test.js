import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { startRezNode } from "@rezprotocol/node";
import { bootstrapChatServer } from "../src/server/index.js";

/**
 * LIVE local-mesh GROUP e2e — fully un-mocked, loopback only.
 *
 *   aliceChat → aliceNode ─┐
 *                          ├─ relayR ─┐
 *   bobChat   → bobNode  ──┘          │
 *
 * The companion e2e.local-mesh.chat proves the DM path. This proves the GROUP
 * lifecycle the desktop two-node test showed broken (2026-06-04): with BOTH
 * clients online, the creator makes a group, invites a peer, the peer accepts,
 * the peer's member.join must reach the creator so BOTH rosters end with two
 * named members, and a group message from EITHER side must reach + decrypt on
 * the other. The reported symptom was that, both online, neither side's group
 * message landed in the other's inbox (and the creator's own message did not
 * even render locally) — strongly implying the member.join op never propagated,
 * leaving each roster without the other member so group fan-out had no target.
 *
 * Real chat-servers + real nodes + real shared relay over real TCP; the full
 * production send path (message.send → sealForPeer → mesh.dispatch → relay →
 * peer inbox → drain → decrypt). Gated behind RUN_LOCAL_MESH_E2E=1.
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

test("live local mesh group: create + invite + member.join roster sync + bidirectional message (both online)", { skip: !RUN, timeout: 120_000 }, async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "rez-local-mesh-group-"));
  const rPort = await getFreePort();
  const started = [];
  try {
    started.push(await startRezNode(relayOnlyConfig({
      dataDir: path.join(tmp, "relay"), listenPort: rPort, relayKeyId: "relay-core-1", knownRelays: [],
    })));

    const alice = await startChatLeaf({ tmp, label: "alice", entryRelayKeyId: "relay-core-1", entryRelayPort: rPort });
    started.push(alice);
    const bob = await startChatLeaf({ tmp, label: "bob", entryRelayKeyId: "relay-core-1", entryRelayPort: rPort });
    started.push(bob);

    await sleep(4_000);

    // --- Alice creates a group + a GROUP invite; Bob accepts ---
    const nonce = String(Date.now());
    const groupTitle = "Local Mesh Group " + nonce;
    const created = await alice.chat.bus.call("group", "create", { title: groupTitle });
    const groupId = created.groupId;
    const aliceThreadId = created.threadId;
    assert.ok(groupId, "Alice creates a group id");
    assert.ok(aliceThreadId, "Alice creates a group thread id");

    const invite = await alice.chat.bus.call("invite", "create", {
      kind: "group", groupId, title: groupTitle, maxUses: 1, creatorDisplayName: "Alice",
    });
    assert.ok(invite.inviteCode, "Alice creates a group invite code");

    const accepted = await bob.chat.bus.call("invite", "accept", {
      inviteCode: invite.inviteCode, acceptorDisplayName: "Bob",
    });
    assert.equal(accepted.groupId, groupId, "Bob's accept resolves the same group");
    const bobThreadId = accepted.groupThreadId;
    assert.ok(bobThreadId, "Bob's accept resolves the group thread id");

    await waitForPeerLinkReady(alice.chat, bob.accountId, "Alice peer-link to Bob ready");
    await waitForPeerLinkReady(bob.chat, alice.accountId, "Bob peer-link to Alice ready");

    // --- member.join must reach Alice; BOTH rosters end with two named members ---
    await waitForGroupMember(alice.chat, groupId, bob.accountId, "Bob joins Alice's roster");
    const aliceRoster = await listMembers(alice.chat, groupId);
    assert.equal(aliceRoster.length, 2, "Alice roster has two members");
    const aliceBobRow = aliceRoster.find((m) => m.accountId === bob.accountId);
    assert.ok(aliceRoster.find((m) => m.accountId === alice.accountId), "Alice's own row present");
    assert.ok(aliceBobRow, "Bob present in Alice's roster");
    assert.equal(aliceBobRow.displayName, "Bob", "Bob's name persisted on Alice's membership row");

    await waitForGroupMember(bob.chat, groupId, alice.accountId, "Alice present in Bob's roster");
    const bobRoster = await listMembers(bob.chat, groupId);
    assert.equal(bobRoster.length, 2, "Bob roster has two members");
    const bobAliceRow = bobRoster.find((m) => m.accountId === alice.accountId);
    assert.ok(bobRoster.find((m) => m.accountId === bob.accountId), "Bob's own row present");
    assert.ok(bobAliceRow, "Alice present in Bob's roster");
    assert.equal(bobAliceRow.displayName, "Alice", "Alice resolves to her invite name in Bob's roster");

    // --- Bob → Alice group message (the screenshot "yo") ---
    const b2a = "yo " + nonce;
    const bobSent = await bob.chat.bus.call("message", "send", {
      threadId: bobThreadId, messageId: "b2a_" + nonce,
      payload: { kind: "rez.chat.message.v1", text: b2a },
    });
    assert.equal(bobSent.threadId, bobThreadId);
    // Bob's own message renders locally on the sender side.
    await waitForMessageText(bob.chat, bobThreadId, b2a, "Bob sees his own group message locally");
    const gotByAlice = await waitForMessageText(alice.chat, aliceThreadId, b2a, "Alice receives Bob's group message");
    assert.equal(gotByAlice.senderAccountId, bob.accountId, "delivered group message credits Bob");

    // --- Alice → Bob group message (the creator's own send must render + deliver) ---
    const a2b = "hey back " + nonce;
    await alice.chat.bus.call("message", "send", {
      threadId: aliceThreadId, messageId: "a2b_" + nonce,
      payload: { kind: "rez.chat.message.v1", text: a2b },
    });
    // The creator's own message must render locally (reported broken).
    await waitForMessageText(alice.chat, aliceThreadId, a2b, "Alice sees her own group message locally");
    const gotByBob = await waitForMessageText(bob.chat, bobThreadId, a2b, "Bob receives Alice's group message");
    assert.equal(gotByBob.senderAccountId, alice.accountId, "delivered group reply credits Alice");
  } finally {
    for (const app of started.reverse()) {
      if (app && app.chat) await stopLeaf(app);
      else if (app && typeof app.stop === "function") await app.stop().catch(() => {});
    }
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
});
