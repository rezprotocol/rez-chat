import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { startRezNode } from "@rezprotocol/node";
import { bootstrapChatServer } from "../src/server/index.js";

/**
 * LIVE local-mesh ASYMMETRIC-RECONNECT e2e — fully un-mocked, loopback only.
 *
 * Reproduces the reported live bug (2026-06-12): Alice and Carol were direct
 * contacts; Alice deleted Carol (her contact + DM thread torn down, the peer-link
 * transport intentionally KEPT); Carol still holds Alice as an active contact with
 * full history. Alice re-adds Carol ("Connect" from the member menu = a connect
 * request). Because Carol ALREADY has Alice active, the receiver-side handler used
 * to consume the request SILENTLY — so Alice could never reconnect.
 *
 * The fix: when the receiver still holds the requester active, AUTO-RECONNECT —
 * re-accept the fresh invite with forceReestablish (re-key the still-healthy link
 * so a handshake actually reaches the requester) and signal acceptance back. The
 * SAME peerLinkId is reused, so the receiver keeps their thread + history and the
 * requester re-materializes a working DM.
 *
 * This asserts the whole round-trip on a real mesh:
 *   - after Alice deletes Carol, Alice has NO DM thread but Carol is untouched;
 *   - after Alice re-requests, Alice's contact + DM thread come BACK;
 *   - Carol's DM thread id is UNCHANGED and her pre-delete history survived;
 *   - the re-keyed session carries NEW messages BOTH ways.
 *
 * Gated behind RUN_LOCAL_MESH_E2E=1.
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

async function listContacts(chat) {
  const result = await chat.bus.call("contacts", "list", {});
  return result && Array.isArray(result.items) ? result.items : [];
}

async function listThreads(chat) {
  const result = await chat.bus.call("threads", "list", { limit: 100 });
  return result && Array.isArray(result.threads) ? result.threads : [];
}

function contactFor(contacts, accountId, state) {
  return (contacts || []).find((c) => c
    && String(c.accountId || "").trim() === accountId
    && String(c.relationshipState || "").toLowerCase() === state) || null;
}

function directThreadFor(threads, accountId) {
  return (threads || []).find((t) => {
    if (!t || typeof t !== "object") return false;
    const type = String(t.threadType || "").trim().toLowerCase();
    const peer = typeof t.peerAccountId === "string" ? t.peerAccountId.trim() : "";
    return type === "direct" && peer === accountId;
  }) || null;
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

test(
  "live local mesh: asymmetric reconnect — receiver who still holds the requester auto-reconnects",
  { skip: !RUN, timeout: 120_000 },
  async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "rez-local-mesh-reconnect-"));
    const rPort = await getFreePort();
    const started = [];
    try {
      started.push(await startRezNode(relayOnlyConfig({
        dataDir: path.join(tmp, "relay"), listenPort: rPort, relayKeyId: "relay-core-1", knownRelays: [],
      })));

      const alice = await startChatLeaf({ tmp, label: "alice", entryRelayKeyId: "relay-core-1", entryRelayPort: rPort });
      started.push(alice);
      const carol = await startChatLeaf({ tmp, label: "carol", entryRelayKeyId: "relay-core-1", entryRelayPort: rPort });
      started.push(carol);

      await sleep(4_000);
      const nonce = String(Date.now());

      // --- Alice ↔ Carol: a real direct contact (out-of-band direct invite) ---
      const direct = await alice.chat.bus.call("invite", "create", { kind: "direct", creatorDisplayName: "Alice" });
      await carol.chat.bus.call("invite", "accept", { inviteCode: direct.inviteCode, acceptorDisplayName: "Carol" });
      await waitForPeerLinkReady(alice.chat, carol.accountId, "Alice↔Carol DM ready");
      await waitForPeerLinkReady(carol.chat, alice.accountId, "Carol↔Alice DM ready");

      const aliceThread = await waitFor(
        async () => directThreadFor(await listThreads(alice.chat), carol.accountId),
        CHAT_TIMEOUT_MS, "Alice's DM thread for Carol",
      );
      const carolThread = await waitFor(
        async () => directThreadFor(await listThreads(carol.chat), alice.accountId),
        CHAT_TIMEOUT_MS, "Carol's DM thread for Alice",
      );
      const carolThreadIdBefore = carolThread.threadId;

      // Alice sends a first message — establishes durable history on Carol's side.
      const msg1 = "before-delete " + nonce;
      await alice.chat.bus.call("message", "send", {
        threadId: aliceThread.threadId, messageId: "m1_" + nonce,
        payload: { kind: "rez.chat.message.v1", text: msg1 },
      });
      await waitForMessageText(carol.chat, carolThreadIdBefore, msg1, "Carol receives Alice's pre-delete message");

      // --- Alice DELETES Carol: her contact + DM thread go; the peer-link is kept.
      //     Carol is untouched — still active, still holding the history. ---
      const del = await alice.chat.bus.call("contacts", "delete", { accountId: carol.accountId });
      assert.equal(del.deleted, true, "Alice deletes Carol");
      await waitFor(
        async () => directThreadFor(await listThreads(alice.chat), carol.accountId) === null ? true : null,
        CHAT_TIMEOUT_MS, "Alice's DM thread for Carol torn down",
      );
      assert.equal(contactFor(await listContacts(alice.chat), carol.accountId, "active"), null,
        "Alice no longer has an ACTIVE contact for Carol");
      assert.ok(contactFor(await listContacts(carol.chat), alice.accountId, "active"),
        "Carol STILL has Alice active (her side untouched by Alice's delete)");

      // --- Alice re-adds Carol (the 'Connect' from the member menu) = requestConnect.
      //     Carol already holds Alice active, so PRE-FIX she dropped this silently. ---
      const req = await alice.chat.bus.call("contacts", "requestConnect", {
        peerAccountId: carol.accountId, displayName: "Alice",
      });
      assert.equal(req.status, "sent", "Alice re-requests a connection to Carol");

      // === RECONNECT: Alice's contact + DM thread come back on their own ===
      await waitFor(
        async () => contactFor(await listContacts(alice.chat), carol.accountId, "active"),
        CHAT_TIMEOUT_MS, "Alice's contact for Carol re-activates",
      );
      const aliceThread2 = await waitFor(
        async () => directThreadFor(await listThreads(alice.chat), carol.accountId),
        CHAT_TIMEOUT_MS, "Alice's DM thread for Carol re-materializes",
      );

      // === Carol keeps her ORIGINAL thread + history (same peerLinkId reused) ===
      const carolThreadAfter = directThreadFor(await listThreads(carol.chat), alice.accountId);
      assert.ok(carolThreadAfter, "Carol still has her DM thread for Alice");
      assert.equal(carolThreadAfter.threadId, carolThreadIdBefore,
        "Carol's thread id is UNCHANGED across the reconnect (no duplicate thread)");
      await waitForMessageText(carol.chat, carolThreadIdBefore, msg1,
        "Carol's pre-delete history survived the reconnect");

      // === The re-keyed session carries NEW traffic BOTH ways ===
      const msg2 = "after-reconnect alice->carol " + nonce;
      await alice.chat.bus.call("message", "send", {
        threadId: aliceThread2.threadId, messageId: "m2_" + nonce,
        payload: { kind: "rez.chat.message.v1", text: msg2 },
      });
      await waitForMessageText(carol.chat, carolThreadIdBefore, msg2,
        "Carol receives Alice's post-reconnect message");

      const msg3 = "after-reconnect carol->alice " + nonce;
      await carol.chat.bus.call("message", "send", {
        threadId: carolThreadAfter.threadId, messageId: "m3_" + nonce,
        payload: { kind: "rez.chat.message.v1", text: msg3 },
      });
      await waitForMessageText(alice.chat, aliceThread2.threadId, msg3,
        "Alice receives Carol's post-reconnect message");
    } finally {
      for (const app of started.reverse()) {
        if (app && app.chat) await stopLeaf(app);
        else if (app && typeof app.stop === "function") await app.stop().catch(() => {});
      }
      await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  },
);
