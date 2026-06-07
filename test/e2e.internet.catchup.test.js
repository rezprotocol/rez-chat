// e2e.internet.catchup.test.js
//
// Live mesh end-to-end of the chat-server-side inbox-catchup path against
// the actual DO relay deployment (no mocks). Distinct from
// e2e.internet.queued.test.js in that BOTH peers go offline and Alice
// comes back first, so:
//
//   * Alice's chat-server has to restore peer-link/ratchet state from
//     her preserved data dir before her send works.
//   * Bob's InboxCatchupService is the chat-server-side drain path that
//     pulls the deposit from his relay-side mailbox on cold boot, via
//     sdk.mailbox.list / sdk.mailbox.fetch and re-emitting
//     runtime.event.mailbox.deposited. The relay's _replayPendingToSocket
//     push path also runs in parallel; the behavioral assertion ("Bob's
//     thread shows the message") is the union of both paths and is what
//     real users see.
//
// Phases:
//   1. Online pairing + baseline send (sanity).
//   2. Stop both stacks; preserve both data dirs.
//   3. Brief settle so relay routes/sockets register the disconnect.
//   4. Start Alice cold from her data dir → she sends to offline Bob.
//      Her row must reach sent/delivered/queued.
//   5. Start Bob cold from his data dir → the message must materialize
//      in Bob's thread without further sender action.
//   6. Alice's row must settle on sent/delivered, never stuck on queued.
//
// Gated on RUN_INTERNET_E2E=1 like the sibling live tests.

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

test("live DO relay mesh: Alice (cold) sends to offline Bob; Bob catches up on cold boot", {
  skip: RUN_LIVE ? false : "set RUN_INTERNET_E2E=1 to run live DigitalOcean chat e2e",
  timeout: 300000,
}, async () => {
  const knownRelays = loadKnownRelays();
  assert.ok(knownRelays.length >= 1, "expected at least one known relay");

  const routePolicy = { defaultHops: 1, forceOnionRouting: false };

  let alice = null;
  let bob = null;
  let aliceDataDir = null;
  let bobDataDir = null;
  let aliceAccountId = null;
  let bobAccountId = null;
  const aliceLabel = "alice-catchup";
  const bobLabel = "bob-catchup";

  try {
    // ---- Phase 1: online pairing + baseline send ----
    alice = await startChatNode(aliceLabel, knownRelays, routePolicy);
    bob = await startChatNode(bobLabel, knownRelays, routePolicy);
    aliceDataDir = alice.dataDir;
    bobDataDir = bob.dataDir;
    aliceAccountId = alice.accountId;
    bobAccountId = bob.accountId;

    await sleep(SETTLE_MS);

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

    const baselineNonce = "catchup-baseline-" + Date.now();
    const baselineText = "online baseline " + baselineNonce;
    const baselineMessageId = "client_" + baselineNonce;
    await alice.chat.bus.call("message", "send", {
      threadId: aliceThreadId,
      messageId: baselineMessageId,
      payload: { kind: "rez.chat.message.v1", text: baselineText },
    });
    await waitForMessageText(bob.chat, bobThreadId, baselineText, CHAT_TIMEOUT_MS);

    // ---- Phase 2: take BOTH stacks offline (preserve data dirs) ----
    await stopChatNode(bob, { preserveTmpDir: true });
    bob = null;
    await stopChatNode(alice, { preserveTmpDir: true });
    alice = null;

    // ---- Phase 3: settle ----
    // Let the mesh observe both uplinks closing. Routes survive socket
    // disconnect by design (RouteTable decouples), but cached
    // reachability hints can be stale; give them a moment.
    await sleep(5000);

    // ---- Phase 4: Alice cold-boots and sends ----
    alice = await startChatNode(aliceLabel, knownRelays, routePolicy, { dataDir: aliceDataDir });
    assert.equal(alice.accountId, aliceAccountId, "Alice's accountId must be stable across restart");

    // Wait until Alice's chat-server has restored her peer-link to Bob
    // from the persisted data dir before sending. Without this we'd race
    // the persistence layer.
    await waitForPeerLinkReady(alice.chat, bobAccountId, CHAT_TIMEOUT_MS, "Alice peer link to Bob after cold boot");
    const aliceThreadIdAfterRestart = await waitForDirectThread(alice.chat, bobAccountId, CHAT_TIMEOUT_MS, "Alice direct thread after cold boot");
    assert.equal(aliceThreadIdAfterRestart, aliceThreadId, "Alice's thread id must be stable across restart");

    const catchupNonce = "catchup-offline-" + Date.now();
    const catchupText = "catchup message " + catchupNonce;
    const catchupMessageId = "client_" + catchupNonce;

    await alice.chat.bus.call("message", "send", {
      threadId: aliceThreadIdAfterRestart,
      messageId: catchupMessageId,
      payload: { kind: "rez.chat.message.v1", text: catchupText },
    });

    // Alice's row should reach sent/delivered (relay accepted the
    // deposit into Bob's mailbox) or queued (no route at all — rarer,
    // covered by the persistent outbound queue).
    const offlineSendStatus = await waitForMessageStatus(
      alice.chat, aliceThreadIdAfterRestart, catchupMessageId,
      ["sent", "delivered", "queued"],
      QUEUED_WAIT_MS,
      "Alice's send-while-Bob-offline (after Alice cold boot) to reach sent/delivered or queued",
    );
    assert.ok(
      offlineSendStatus === "sent" || offlineSendStatus === "delivered" || offlineSendStatus === "queued",
      "expected sent/delivered/queued after offline send, got " + offlineSendStatus,
    );

    // ---- Phase 5: Bob cold-boots → catchup must materialize message ----
    bob = await startChatNode(bobLabel, knownRelays, routePolicy, { dataDir: bobDataDir });

    assert.equal(bob.accountId, bobAccountId, "Bob's accountId must be stable across restart");

    const bobReceived = await waitForMessageText(bob.chat, bobThreadId, catchupText, FLUSH_WAIT_MS);
    assert.equal(bobReceived.text, catchupText, "Bob should receive the message via inbox catchup");
    assert.equal(bobReceived.senderAccountId, aliceAccountId);
    assert.equal(bobReceived.messageId, catchupMessageId,
      "messageId must round-trip unchanged (delivery idempotency)");

    // ---- Phase 6: Alice's row settles on success ----
    const finalStatus = await waitForMessageStatus(
      alice.chat, aliceThreadIdAfterRestart, catchupMessageId,
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
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "rez-chat-live-catchup-" + label + "-"));
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
    await app.chat.stop().catch((err) => {
      console.warn("[" + app.label + "] chat.stop failed:", err && err.message ? err.message : err);
    });
  }
  if (app.nodeApp && typeof app.nodeApp.stop === "function") {
    await app.nodeApp.stop().catch((err) => {
      console.warn("[" + app.label + "] node.stop failed:", err && err.message ? err.message : err);
    });
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
