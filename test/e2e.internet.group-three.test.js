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
 * LIVE DO-relay THREE-MEMBER TRANSITIVE group e2e — fully un-mocked, real
 * DigitalOcean relays (r1/r2/r3.rezprotocol.io:8443, TLS).
 *
 *   Alice invites Bob; BOB (a non-creator) invites Carol.
 *
 * Alice and Carol never invited each other, so before the member-introduction
 * protocol they shared no peer link — Alice saw Carol in the roster but never
 * her messages (and vice-versa), because group fan-out seals per-peer with no
 * relay. This is the live-internet counterpart to e2e.local-mesh.group-three,
 * proving the X3DH introduction handshake forms a FULL MESH over the real relay
 * network (TLS, real latency), not just loopback.
 *
 * Gated behind RUN_INTERNET_E2E=1. See project_group_peerlinks_invite_tree_not_mesh.
 */

const RUN_LIVE = String(process.env.RUN_INTERNET_E2E || "").trim() === "1";
const ASSERT_ONION_PROOF = String(process.env.REZ_E2E_ASSERT_ONION_PROOF || "").trim() === "1";
const SETTLE_MS = Number.parseInt(String(process.env.REZ_CHAT_E2E_SETTLE_MS || "10000"), 10);
const CHAT_TIMEOUT_MS = Number.parseInt(String(process.env.REZ_CHAT_E2E_TIMEOUT_MS || "90000"), 10);

const silentLogger = {
  log() {},
  info() {},
  warn() {},
  error() {},
  debug() {},
};

test("live DO relay mesh: transitive group meshes Alice<->Carol (A invites B, B invites C)", {
  skip: RUN_LIVE ? false : "set RUN_INTERNET_E2E=1 to run live DigitalOcean transitive group e2e",
  timeout: 300000,
}, async () => {
  const knownRelays = loadKnownRelays();
  assert.ok(knownRelays.length >= 1, "expected at least one known relay");

  const routePolicy = ASSERT_ONION_PROOF
    ? { defaultHops: 3, forceOnionRouting: true }
    : { defaultHops: 1, forceOnionRouting: false };

  let alice = null;
  let bob = null;
  let carol = null;
  try {
    alice = await startChatNode({ label: "alice", knownRelays, routePolicy });
    bob = await startChatNode({ label: "bob", knownRelays, routePolicy });
    carol = await startChatNode({ label: "carol", knownRelays, routePolicy });

    await sleep(SETTLE_MS);

    const nonce = "grp3-live-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
    const groupTitle = "Live Mesh3 " + nonce;

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
    assert.equal(acceptedB.groupId, groupId, "Bob joins the same group");

    await waitForPeerLinkReady(alice.chat, bob.accountId, CHAT_TIMEOUT_MS, "Alice<->Bob ready");
    await waitForPeerLinkReady(bob.chat, alice.accountId, CHAT_TIMEOUT_MS, "Bob<->Alice ready");
    await waitForGroupMember(alice.chat, groupId, bob.accountId, CHAT_TIMEOUT_MS, "Bob in Alice roster");

    // --- Bob (a non-creator member) invites Carol; Carol accepts ---
    const inviteC = await bob.chat.bus.call("invite", "create", {
      kind: "group", groupId, title: groupTitle, maxUses: 1, creatorDisplayName: "Bob",
    });
    const acceptedC = await carol.chat.bus.call("invite", "accept", {
      inviteCode: inviteC.inviteCode, acceptorDisplayName: "Carol",
    });
    assert.equal(acceptedC.groupId, groupId, "Carol joins the same group");
    const carolThreadId = acceptedC.groupThreadId;

    await waitForPeerLinkReady(bob.chat, carol.accountId, CHAT_TIMEOUT_MS, "Bob<->Carol ready");
    await waitForPeerLinkReady(carol.chat, bob.accountId, CHAT_TIMEOUT_MS, "Carol<->Bob ready");

    // --- The fix: Alice and Carol mesh DIRECTLY via the introduction, even
    //     though neither invited the other, over the real relay network. ---
    await waitForPeerLinkReady(alice.chat, carol.accountId, CHAT_TIMEOUT_MS, "Alice<->Carol meshed via introduction");
    await waitForPeerLinkReady(carol.chat, alice.accountId, CHAT_TIMEOUT_MS, "Carol<->Alice meshed via introduction");

    await waitForGroupMember(alice.chat, groupId, carol.accountId, CHAT_TIMEOUT_MS, "Carol in Alice roster");
    await waitForGroupMember(carol.chat, groupId, alice.accountId, CHAT_TIMEOUT_MS, "Alice in Carol roster");
    assert.equal((await listMembers(alice.chat, groupId)).length, 3, "Alice roster has 3");
    assert.equal((await listMembers(carol.chat, groupId)).length, 3, "Carol roster has 3");

    // --- Carol -> group message must reach Alice (the reported bug) ---
    const c2all = "carol-says " + nonce;
    await carol.chat.bus.call("message", "send", {
      threadId: carolThreadId, messageId: "c2all_" + nonce,
      payload: { kind: "rez.chat.message.v1", text: c2all },
    });
    const aliceGotCarol = await waitForMessageText(alice.chat, aliceThreadId, c2all, CHAT_TIMEOUT_MS, "Alice receives Carol's message");
    assert.equal(aliceGotCarol.senderAccountId, carol.accountId, "credited to Carol");

    // --- Alice -> group message must reach Carol ---
    const a2all = "alice-says " + nonce;
    await alice.chat.bus.call("message", "send", {
      threadId: aliceThreadId, messageId: "a2all_" + nonce,
      payload: { kind: "rez.chat.message.v1", text: a2all },
    });
    const carolGotAlice = await waitForMessageText(carol.chat, carolThreadId, a2all, CHAT_TIMEOUT_MS, "Carol receives Alice's message");
    assert.equal(carolGotAlice.senderAccountId, alice.accountId, "credited to Alice");
  } finally {
    await stopChatNode(carol);
    await stopChatNode(bob);
    await stopChatNode(alice);
  }
});

async function startChatNode({ label, knownRelays, routePolicy } = {}) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "rez-chat-live-group3-" + label + "-"));
  const dataDir = path.join(tmpDir, "node-data");
  await fs.mkdir(dataDir, { recursive: true });

  const wsPort = await getFreePort();
  const wsPath = "/ws";
  const config = {
    node: {
      ws: { host: "127.0.0.1", port: wsPort, path: wsPath },
      storage: { dataDir },
      network: { participateInRouting: true, knownRelays },
      mesh: {
        enabled: true,
        mode: "seed-only",
        seeds: [],
        minPeers: 1,
        maxPeers: 5,
        policy: routePolicy,
      },
      relay: { listenHost: "127.0.0.1", listenPort: 0 },
    },
  };

  const nodeApp = await startRezNode(config);
  const wsUrl = "ws://127.0.0.1:" + wsPort + wsPath;
  const bootstrapped = await bootstrapChatServer({ nodeDataDir: dataDir, wsUrl, logger: silentLogger });
  await bootstrapped.chatServer.start();

  return {
    label,
    tmpDir,
    dataDir,
    nodeApp,
    chat: bootstrapped.chatServer,
    accountId: bootstrapped.ownerAccountId,
    wsUrl,
  };
}

async function stopChatNode(app) {
  if (!app) return;
  if (app.chat && typeof app.chat.stop === "function") {
    await app.chat.stop().catch(() => {});
  }
  if (app.nodeApp && typeof app.nodeApp.stop === "function") {
    await app.nodeApp.stop().catch(() => {});
  }
  if (app.tmpDir) {
    await fs.rm(app.tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

// The live DO relays are the production knownRelays baked into the default rez
// config (r1/r2/r3.rezprotocol.io:8443, TLS) — the exact set the shipped app
// dials. Use them directly so this test needs no relay-info.json overlay.
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
