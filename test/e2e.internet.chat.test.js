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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const RELAY_INFO_PATH = path.resolve(REPO_ROOT, "relays", "relay-info.json");

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

test("live DO relay mesh delivers chat invite and message between two chat clients", {
  skip: RUN_LIVE ? false : "set RUN_INTERNET_E2E=1 to run live DigitalOcean chat e2e",
  timeout: 120000,
}, async () => {
  const knownRelays = loadKnownRelays();
  assert.ok(knownRelays.length >= 1, "expected at least one known relay");

  const routePolicy = ASSERT_ONION_PROOF
    ? { defaultHops: 3, forceOnionRouting: true }
    : { defaultHops: 1, forceOnionRouting: false };

  let alice = null;
  let bob = null;
  try {
    alice = await startChatNode("alice", knownRelays, routePolicy);
    bob = await startChatNode("bob", knownRelays, routePolicy);

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
    assert.ok(accepted.peerLinkId, "Bob accept should create a peer link");
    assert.ok(accepted.threadId, "Bob accept should create a chat thread");

    const bobThreadId = accepted.threadId;
    const alicePeerLink = await waitForPeerLinkReady(alice.chat, bob.accountId, CHAT_TIMEOUT_MS, "Alice peer link to Bob");
    const aliceThreadId = await waitForDirectThread(alice.chat, bob.accountId, CHAT_TIMEOUT_MS, "Alice direct thread");
    await waitForThread(bob.chat, bobThreadId, CHAT_TIMEOUT_MS, "Bob accepted thread");
    assert.ok(peerLinkPeerInboxId(alicePeerLink), "Alice peer link should expose Bob inbox binding");

    const nonce = "chat-live-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
    const text = "hello over rez chat live mesh " + nonce;
    const sent = await alice.chat.bus.call("message", "send", {
      threadId: aliceThreadId,
      messageId: "client_" + nonce,
      payload: {
        kind: "rez.chat.message.v1",
        text,
      },
    });
    assert.equal(sent.threadId, aliceThreadId);
    assert.ok(sent.messageId, "message send should return a message id");

    const bobMessage = await waitForMessageText(bob.chat, bobThreadId, text, CHAT_TIMEOUT_MS);
    assert.equal(bobMessage.text, text);
    assert.equal(bobMessage.payload.text, text);
    assert.equal(bobMessage.senderAccountId, alice.accountId);

    const bobThread = await bob.chat.bus.call("thread", "get", { threadId: bobThreadId, limit: 20 });
    assert.ok(bobThread.thread, "Bob thread should load after message delivery");
    assert.equal(bobThread.thread.peerAccountId, alice.accountId);
  } finally {
    await stopChatNode(bob);
    await stopChatNode(alice);
  }
});

async function startChatNode(label, knownRelays, routePolicy) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "rez-chat-live-" + label + "-"));
  const dataDir = path.join(tmpDir, "node-data");
  await fs.mkdir(dataDir, { recursive: true });

  const wsPort = await getFreePort();
  const wsPath = "/ws";
  // No directory: the HTTP directory was removed and replaced by relay-to-relay
  // descriptor exchange. Nodes bootstrap purely from knownRelays — exactly as
  // the production app does. Mesh seeds stay empty.
  const config = {
    node: {
      ws: { host: "127.0.0.1", port: wsPort, path: wsPath },
      storage: { dataDir },
      network: { participateInRouting: true, knownRelays },
      mesh: {
        enabled: true,
        mode: "seeded-gossip",
        seeds: [],
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

function loadKnownRelays() {
  const raw = readFileSync(RELAY_INFO_PATH, "utf8");
  const parsed = JSON.parse(raw);
  const relays = parsed && Array.isArray(parsed.relays) ? parsed.relays : [];
  return relays.map((relay) => {
    const relayKeyId = String(relay.relayKeyId || "").trim();
    const endpoint = parseRelayEndpoint(relay.relayEndpoint);
    if (!relayKeyId) throw new Error("relay is missing relayKeyId");
    if (!endpoint) throw new Error("relay has invalid relayEndpoint");
    return {
      id: relayKeyId,
      relayKeyId,
      host: endpoint.host,
      port: endpoint.port,
      transport: "tcp",
      tls: endpoint.protocol === "tls",
    };
  });
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

function peerLinkPeerInboxId(item) {
  if (!item || typeof item !== "object") return "";
  return typeof item.peerInboxId === "string" ? item.peerInboxId.trim() : "";
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
  }, timeoutMs, "message delivery to Bob");
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
