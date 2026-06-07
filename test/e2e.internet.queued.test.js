// e2e.internet.queued.test.js
//
// Live mesh end-to-end of the offline-delivery path against the actual
// DO relay deployment (no mocks). What this exercises:
//
//   1. Alice + Bob both online → invite/accept → peer-link established
//      → baseline message delivers (sanity).
//   2. Bob is shut down (node + chat-server).
//   3. Alice sends another message. In the production topology, Bob's
//      relay-side mailbox binding survives Bob's local-node shutdown,
//      so Alice's deposit lands in the relay's mailbox for Bob and
//      Alice's row goes to "sent" immediately. (The persistent outbound
//      queue's "queued" status only triggers when no relay accepts the
//      deposit — i.e. destination's mailbox is gone — which is rarer
//      than "friend closed his app" and is covered by un-mocked unit
//      tests in messages.resend.test.js.)
//   4. Bob is restarted with the same data dir. On reconnect to the
//      relays, his chat-server pulls the deposited mail; the message
//      materializes in Bob's thread without any further sender action.
//
// This test proves the dominant offline-delivery story end-to-end:
// receiver-side requires no client changes; the existing relay mailbox
// poll handles it. Gated on RUN_INTERNET_E2E=1 like the sibling baseline.

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { startRezNode } from "@rezprotocol/node";
import { bootstrapChatServer } from "../src/server/index.js";
import { createDefaultRezConfig } from "../src/server/config/defaultRezConfig.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const RELAY_INFO_PATH = path.resolve(REPO_ROOT, "relays", "relay-info.json");

const RUN_LIVE = String(process.env.RUN_INTERNET_E2E || "").trim() === "1";
const SETTLE_MS = Number.parseInt(String(process.env.REZ_CHAT_E2E_SETTLE_MS || "10000"), 10);
const CHAT_TIMEOUT_MS = Number.parseInt(String(process.env.REZ_CHAT_E2E_TIMEOUT_MS || "60000"), 10);
const QUEUED_WAIT_MS = Number.parseInt(String(process.env.REZ_CHAT_E2E_QUEUED_WAIT_MS || "30000"), 10);
const FLUSH_WAIT_MS = Number.parseInt(String(process.env.REZ_CHAT_E2E_FLUSH_WAIT_MS || "90000"), 10);

const silentLogger = process.env.REZ_INBOX_CATCHUP_DEBUG === "1"
  ? console
  : {
    log() {},
    info() {},
    warn() {},
    error() {},
    debug() {},
  };

test("live DO relay mesh delivers a send to offline peer once peer returns", {
  skip: RUN_LIVE ? false : "set RUN_INTERNET_E2E=1 to run live DigitalOcean chat e2e",
  timeout: 240000,
}, async () => {
  const knownRelays = loadKnownRelays();
  assert.ok(knownRelays.length >= 1, "expected at least one known relay");

  const routePolicy = { defaultHops: 1, forceOnionRouting: false };

  let alice = null;
  let bob = null;
  let bobDataDir = null;
  let bobLabel = "bob-queue";
  try {
    alice = await startChatNode("alice-queue", knownRelays, routePolicy);
    bob = await startChatNode(bobLabel, knownRelays, routePolicy);
    bobDataDir = bob.dataDir;

    await sleep(SETTLE_MS);

    // ---- Phase 1: online baseline ----
    const invite = await alice.chat.bus.call("invite", "create", {
      kind: "direct",
      maxUses: 1,
      creatorDisplayName: "Alice",
    });
    assert.ok(invite.inviteCode, "Alice should create an invite code");

    const accepted = await bob.chat.bus.call("invite", "accept", {
      inviteCode: invite.inviteCode,
      acceptorDisplayName: "Bob",
    });
    assert.equal(accepted.peerAccountId, alice.accountId);
    assert.ok(accepted.threadId, "Bob accept should create a chat thread");

    const bobThreadId = accepted.threadId;
    await waitForPeerLinkReady(alice.chat, bob.accountId, CHAT_TIMEOUT_MS, "Alice peer link to Bob");
    const aliceThreadId = await waitForDirectThread(alice.chat, bob.accountId, CHAT_TIMEOUT_MS, "Alice direct thread");
    await waitForThread(bob.chat, bobThreadId, CHAT_TIMEOUT_MS, "Bob accepted thread");

    const baselineNonce = "queue-baseline-" + Date.now();
    const baselineText = "online baseline " + baselineNonce;
    const baselineMessageId = "client_" + baselineNonce;
    await alice.chat.bus.call("message", "send", {
      threadId: aliceThreadId,
      messageId: baselineMessageId,
      payload: { kind: "rez.chat.message.v1", text: baselineText },
    });
    await waitForMessageText(bob.chat, bobThreadId, baselineText, CHAT_TIMEOUT_MS);

    // ---- Phase 2: take Bob offline ----
    await stopChatNode(bob, { preserveTmpDir: true });
    bob = null;

    // Give the mesh a moment to register Bob's WS uplinks closing and for
    // any reachability hints to expire in Alice's view. We don't strictly
    // need full route expiry — the GatewayLoop attempt itself will fail
    // when the transport tries to actually deliver — but a short settle
    // reduces flakiness when route cache still says "fresh".
    await sleep(5000);

    // ---- Phase 3: send into the void → must queue ----
    const queuedNonce = "queue-offline-" + Date.now();
    const queuedText = "queued message " + queuedNonce;
    const queuedMessageId = "client_" + queuedNonce;

    // Bob is offline. Alice's send should land in Bob's relay-side
    // mailbox; her row should reach "sent" immediately. We allow
    // "queued" as a fallback for the rarer case where the deposit
    // can't be accepted (no relay route to Bob's inbox at all).
    await alice.chat.bus.call("message", "send", {
      threadId: aliceThreadId,
      messageId: queuedMessageId,
      payload: { kind: "rez.chat.message.v1", text: queuedText },
    });

    const offlineSendStatus = await waitForMessageStatus(
      alice.chat, aliceThreadId, queuedMessageId,
      ["sent", "delivered", "queued"],
      QUEUED_WAIT_MS,
      "Alice's send-while-Bob-offline to reach sent/delivered (relay mailbox) or queued (no route)",
    );
    assert.ok(
      offlineSendStatus === "sent" || offlineSendStatus === "delivered" || offlineSendStatus === "queued",
      "expected sent/delivered/queued after offline send, got " + offlineSendStatus,
    );

    // ---- Phase 4: bring Bob back; the message must reach Bob's thread ----
    bob = await startChatNode(bobLabel, knownRelays, routePolicy, { dataDir: bobDataDir });

    // If Phase 3 queued (rare), the route-added → flushForInbox path
    // drives it. If Phase 3 went straight to sent (common), Bob just
    // polls his relay mailbox on reconnect. Either way the message
    // must materialize in Bob's thread.
    const bobReceived = await waitForMessageText(bob.chat, bobThreadId, queuedText, FLUSH_WAIT_MS);
    assert.equal(bobReceived.text, queuedText, "Bob should receive the message Alice sent while he was offline");
    assert.equal(bobReceived.senderAccountId, alice.accountId);
    assert.equal(bobReceived.messageId, queuedMessageId,
      "messageId must round-trip unchanged (delivery idempotency)");

    // And Alice's row must end on a successful state (sent or delivered)
    // — never stuck on queued, never failed.
    const finalStatus = await waitForMessageStatus(
      alice.chat, aliceThreadId, queuedMessageId,
      ["sent", "delivered"],
      FLUSH_WAIT_MS,
      "Alice's row to settle on sent/delivered after Bob's return",
    );
    assert.ok(finalStatus === "sent" || finalStatus === "delivered",
      "after Bob returns, Alice's row must settle on sent/delivered; got " + finalStatus);
  } finally {
    await stopChatNode(bob);
    await stopChatNode(alice);
  }
});

async function startChatNode(label, knownRelays, routePolicy, { dataDir: existingDataDir } = {}) {
  let tmpDir;
  let dataDir;
  if (existingDataDir) {
    dataDir = existingDataDir;
    tmpDir = path.dirname(existingDataDir);
  } else {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "rez-chat-live-queue-" + label + "-"));
    dataDir = path.join(tmpDir, "node-data");
    await fs.mkdir(dataDir, { recursive: true });
  }

  const wsPort = await getFreePort();
  const wsPath = "/ws";
  const directorySources = knownRelays.map((relay) => relay.directoryUrl).filter(Boolean);
  const config = {
    node: {
      ws: { host: "127.0.0.1", port: wsPort, path: wsPath },
      storage: { dataDir },
      network: { participateInRouting: true, knownRelays },
      mesh: {
        enabled: true,
        mode: "seeded-gossip",
        seeds: directorySources,
        minPeers: 3,
        maxPeers: 10,
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
    nodeDataDir: dataDir,
    wsUrl,
    logger: silentLogger,
  });
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

async function stopChatNode(app, { preserveTmpDir = false } = {}) {
  if (!app) return;
  if (app.chat && typeof app.chat.stop === "function") {
    await app.chat.stop().catch(() => {});
  }
  if (app.nodeApp && typeof app.nodeApp.stop === "function") {
    await app.nodeApp.stop().catch(() => {});
  }
  if (!preserveTmpDir && app.tmpDir) {
    await fs.rm(app.tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

function loadKnownRelays() {
  // SSOT: the live relay set lives in defaultRezConfig.knownRelays (the same
  // loader the passing group e2e tests use). The old relays/relay-info.json
  // file is deprecated and no longer shipped.
  const cfg = createDefaultRezConfig({ dataDir: path.join(os.tmpdir(), "rez-relay-cfg-ignored") });
  const relays = cfg && cfg.node && cfg.node.network && Array.isArray(cfg.node.network.knownRelays)
    ? cfg.node.network.knownRelays : [];
  return relays.map((relay) => ({ ...relay }));
}

function parseRelayEndpoint(value) {
  const text = typeof value === "string" ? value.trim() : "";
  const match = text.match(/^(tcp|tls):\/\/([^:]+):(\d+)$/i);
  if (!match) return null;
  const protocol = String(match[1] || "").toLowerCase();
  const host = String(match[2] || "").trim();
  const port = Number(match[3]);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { protocol, host, port };
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

async function waitForDirectThread(chat, peerAccountId, timeoutMs, label) {
  const thread = await waitFor(async () => {
    const result = await chat.bus.call("threads", "list", { limit: 50 });
    const threads = result && Array.isArray(result.threads) ? result.threads : [];
    return threads.find((item) => {
      if (!item || typeof item !== "object") return false;
      const peer = typeof item.peerAccountId === "string" ? item.peerAccountId.trim() : "";
      const peerInboxId = typeof item.peerInboxId === "string" ? item.peerInboxId.trim() : "";
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
  return waitFor(async () => {
    const result = await chat.bus.call("thread.messages", "list", { threadId, limit: 50 });
    const items = result && Array.isArray(result.items) ? result.items : [];
    return items.find((message) => {
      if (!message || typeof message !== "object") return false;
      if (message.text === text) return true;
      return message.payload && typeof message.payload === "object" && message.payload.text === text;
    });
  }, timeoutMs, "message delivery (" + text + ")");
}

async function waitForMessageStatus(chat, threadId, messageId, acceptableStatuses, timeoutMs, label) {
  const wanted = new Set(acceptableStatuses);
  const observed = [];
  const result = await waitFor(async () => {
    const list = await chat.bus.call("thread.messages", "list", { threadId, limit: 100 });
    const items = list && Array.isArray(list.items) ? list.items : [];
    const row = items.find((m) => m && m.messageId === messageId);
    if (!row) return null;
    const status = typeof row.status === "string" ? row.status : "";
    if (observed[observed.length - 1] !== status) observed.push(status);
    return wanted.has(status) ? status : null;
  }, timeoutMs, label + " (observed status transitions: " + observed.join(",") + ")");
  return result;
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
