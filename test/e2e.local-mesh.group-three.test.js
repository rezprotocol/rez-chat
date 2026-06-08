import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { startRezNode } from "@rezprotocol/node";
import { bootstrapChatServer } from "../src/server/index.js";

/**
 * LIVE local-mesh THREE-MEMBER group e2e — fully un-mocked, loopback only.
 *
 *   aliceChat → aliceNode ─┐
 *   bobChat   → bobNode   ─┼─ relayR
 *   carolChat → carolNode ─┘
 *
 * The 2-member companion (e2e.local-mesh.group) proves creator↔invitee. This
 * proves the TRANSITIVE case that was broken: Alice invites Bob, then BOB invites
 * Carol. Alice and Carol never invited each other, so before the member-introduction
 * protocol they shared no peer link — Alice saw Carol in the roster but never her
 * messages (and vice-versa), because group fan-out seals per-peer with no relay.
 *
 * With member.contact propagation + the X3DH introduction handshake, the group
 * becomes a FULL MESH: Alice↔Carol establish a direct link and exchange group
 * messages both ways. Gated behind RUN_LOCAL_MESH_E2E=1.
 * See project_group_peerlinks_invite_tree_not_mesh.
 */

const RUN = process.env.RUN_LOCAL_MESH_E2E === "1";
const CHAT_TIMEOUT_MS = 45_000;

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

test("live local mesh: transitive group meshes Alice↔Carol (A invites B, B invites C)", { skip: !RUN, timeout: 120_000 }, async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "rez-local-mesh-group3-"));
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
    const carol = await startChatLeaf({ tmp, label: "carol", entryRelayKeyId: "relay-core-1", entryRelayPort: rPort });
    started.push(carol);

    await sleep(4_000);

    const nonce = String(Date.now());
    const groupTitle = "Mesh3 " + nonce;

    // --- Alice creates a group + invites Bob; Bob accepts ---
    const created = await alice.chat.bus.call("group", "create", { title: groupTitle });
    const groupId = created.groupId;
    const aliceThreadId = created.threadId;
    assert.ok(groupId && aliceThreadId, "Alice creates group + thread");

    const inviteB = await alice.chat.bus.call("invite", "create", {
      kind: "group", groupId, title: groupTitle, maxUses: 1, creatorDisplayName: "Alice",
    });
    const acceptedB = await bob.chat.bus.call("invite", "accept", {
      inviteCode: inviteB.inviteCode, acceptorDisplayName: "Bob",
    });
    assert.equal(acceptedB.groupId, groupId);
    const bobThreadId = acceptedB.groupThreadId;

    await waitForPeerLinkReady(alice.chat, bob.accountId, "Alice↔Bob ready");
    await waitForPeerLinkReady(bob.chat, alice.accountId, "Bob↔Alice ready");
    await waitForGroupMember(alice.chat, groupId, bob.accountId, "Bob in Alice roster");

    // --- Bob (a non-creator member) invites Carol; Carol accepts ---
    const inviteC = await bob.chat.bus.call("invite", "create", {
      kind: "group", groupId, title: groupTitle, maxUses: 1, creatorDisplayName: "Bob",
    });
    const acceptedC = await carol.chat.bus.call("invite", "accept", {
      inviteCode: inviteC.inviteCode, acceptorDisplayName: "Carol",
    });
    assert.equal(acceptedC.groupId, groupId, "Carol joins the same group");
    const carolThreadId = acceptedC.groupThreadId;

    await waitForPeerLinkReady(bob.chat, carol.accountId, "Bob↔Carol ready");
    await waitForPeerLinkReady(carol.chat, bob.accountId, "Carol↔Bob ready");

    // --- The new behavior: Alice and Carol mesh DIRECTLY via the introduction,
    //     even though neither invited the other. ---
    await waitForPeerLinkReady(alice.chat, carol.accountId, "Alice↔Carol meshed via introduction");
    await waitForPeerLinkReady(carol.chat, alice.accountId, "Carol↔Alice meshed via introduction");

    // Rosters: Alice learns Carol (forwarded member.join); Carol learns Alice
    // (member.contact). Both end with all three members.
    await waitForGroupMember(alice.chat, groupId, carol.accountId, "Carol in Alice roster");
    await waitForGroupMember(carol.chat, groupId, alice.accountId, "Alice in Carol roster");
    assert.equal((await listMembers(alice.chat, groupId)).length, 3, "Alice roster has 3");
    assert.equal((await listMembers(carol.chat, groupId)).length, 3, "Carol roster has 3");

    // --- Carol → group message must reach Alice (the reported bug) ---
    const c2all = "carol-says " + nonce;
    await carol.chat.bus.call("message", "send", {
      threadId: carolThreadId, messageId: "c2all_" + nonce,
      payload: { kind: "rez.chat.message.v1", text: c2all },
    });
    const aliceGotCarol = await waitForMessageText(alice.chat, aliceThreadId, c2all, "Alice receives Carol's message");
    assert.equal(aliceGotCarol.senderAccountId, carol.accountId, "credited to Carol");

    // --- Alice → group message must reach Carol ---
    const a2all = "alice-says " + nonce;
    await alice.chat.bus.call("message", "send", {
      threadId: aliceThreadId, messageId: "a2all_" + nonce,
      payload: { kind: "rez.chat.message.v1", text: a2all },
    });
    const carolGotAlice = await waitForMessageText(carol.chat, carolThreadId, a2all, "Carol receives Alice's message");
    assert.equal(carolGotAlice.senderAccountId, alice.accountId, "credited to Alice");
  } finally {
    for (const app of started.reverse()) {
      if (app && app.chat) await stopLeaf(app);
      else if (app && typeof app.stop === "function") await app.stop().catch(() => {});
    }
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
});
