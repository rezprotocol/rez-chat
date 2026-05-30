import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

import { startRezChat } from "../src/index.js";
import { createDefaultRezConfig } from "../src/server/config/defaultRezConfig.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHAT_ROOT = path.resolve(__dirname, "..");

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "rez-twonode-"));
const A_DATA = path.join(ROOT, "a-data");
const B_DATA = path.join(ROOT, "b-data");
const A_CONFIG = path.join(ROOT, "a.config.json");
const B_CONFIG = path.join(ROOT, "b.config.json");

function writeConfig(filePath, wsPort, dataDir) {
  const cfg = createDefaultRezConfig({ dataDir });
  cfg.node.ws.port = wsPort;
  cfg.node.ws.host = "127.0.0.1";
  fs.writeFileSync(filePath, JSON.stringify(cfg, null, 2));
}

writeConfig(A_CONFIG, 18801, A_DATA);
writeConfig(B_CONFIG, 18802, B_DATA);

const stamp = () => {
  const d = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
};
const log = (...args) => console.log(`${stamp()} [test]`, ...args);

function waitForEvent(bus, eventName, predicate, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    let off = null;
    const timer = setTimeout(() => {
      if (off) off();
      reject(new Error(`timeout (${timeoutMs}ms) waiting for "${eventName}"${label ? " — " + label : ""}`));
    }, timeoutMs);
    off = bus.on(eventName, (payload) => {
      let ok = false;
      try {
        ok = !predicate || predicate(payload);
      } catch (err) {
        clearTimeout(timer);
        off();
        reject(err);
        return;
      }
      if (ok) {
        clearTimeout(timer);
        off();
        resolve(payload);
      }
    });
  });
}

function tapBus(bus, label) {
  bus.on("peer-link.updated", (p) => log(`[${label}] EVT peer-link.updated state=${p && p.state} thread=${p && p.threadId} remote=${p && p.peerAccountId}`));
  bus.on("peerlink.protocol.snapshot", (p) => log(`[${label}] EVT peerlink.protocol.snapshot state=${p && p.state} peerLinkId=${p && p.peerLinkId}`));
  bus.on("message.deposited", (p) => {
    const msg = p && p.message ? p.message : {};
    log(`[${label}] EVT message.deposited thread=${msg.threadId} sender=${msg.senderAccountId} text=${JSON.stringify(msg.text || "")}`);
  });
  bus.on("message.status", (p) => log(`[${label}] EVT message.status thread=${p && p.threadId} id=${p && p.messageId} status=${p && p.status}`));
  bus.on("app.error", (p) => log(`[${label}] EVT app.error src=${p && p.source} msg=${p && p.message} err=${p && p.err && p.err.message}`));
}

async function settleConnected(label, app, timeoutMs) {
  // Heuristic: wait until at least one descriptor is published / relay connected.
  // No clean bus signal exists for "connected to N relays"; sleep and report.
  const start = Date.now();
  const deadline = start + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    // We rely on rez-chat / rez-node's own startup logs for visibility.
    if (Date.now() - start > 8000) return; // 8s settle window
  }
}

async function main() {
  log("=== TWO-NODE REAL TEST START ===");
  log("data root:", ROOT);

  log("[A] starting (ws=18801, shell=18901)...");
  const A = await startRezChat({
    configPath: A_CONFIG,
    shellPort: 18901,
    shellHost: "127.0.0.1",
    skipUiRootCheck: true,
  });
  log("[A] started, wsUrl:", A.wsUrl, "ownerAccountId:", A.chatServer && A.chatServer.ownerAccountId);

  log("[B] starting (ws=18802, shell=18902)...");
  const B = await startRezChat({
    configPath: B_CONFIG,
    shellPort: 18902,
    shellHost: "127.0.0.1",
    skipUiRootCheck: true,
  });
  log("[B] started, wsUrl:", B.wsUrl, "ownerAccountId:", B.chatServer && B.chatServer.ownerAccountId);

  tapBus(A.chatServer.bus, "A");
  tapBus(B.chatServer.bus, "B");

  // Give relays time to connect, descriptors to publish, hosted-inbox registration to complete.
  log("settling 12s for relay connect + inbox registration + DHT descriptor publish...");
  await new Promise((r) => setTimeout(r, 12000));

  // ---- Step 1: A creates invite ----
  log("[A] >>> invite.create");
  let inviteResult;
  try {
    inviteResult = await A.chatServer.bus.call("invite", "create", {
      kind: "direct",
      maxUses: 1,
      creatorDisplayName: "Alice",
    });
  } catch (err) {
    log("[A] !!! invite.create FAILED:", err && err.message);
    throw err;
  }
  log("[A] <<< invite.create OK code=", inviteResult.inviteCode);

  // ---- Step 2: set up wait for session_established on BOTH sides ----
  const aWait = waitForEvent(
    A.chatServer.bus,
    "peer-link.updated",
    (p) => p && (p.state === "session_established" || p.state === "established"),
    45000,
    "A session_established",
  );
  const bWait = waitForEvent(
    B.chatServer.bus,
    "peer-link.updated",
    (p) => p && (p.state === "session_established" || p.state === "established"),
    45000,
    "B session_established",
  );

  // ---- Step 3: B accepts invite ----
  log("[B] >>> invite.accept");
  let acceptResult;
  try {
    acceptResult = await B.chatServer.bus.call("invite", "accept", {
      inviteCode: inviteResult.inviteCode,
      acceptorDisplayName: "Bob",
    });
  } catch (err) {
    log("[B] !!! invite.accept FAILED:", err && err.message);
    aWait.catch(() => {});
    bWait.catch(() => {});
    throw err;
  }
  log("[B] <<< invite.accept OK state=", acceptResult.state, "peerLinkId=", acceptResult.peerLinkId, "remote=", acceptResult.peerAccountId, "thread=", acceptResult.threadId);

  // ---- Step 4: Wait for both sides to reach session_established ----
  log("[A] waiting for session_established...");
  const aSnap = await aWait;
  log(`[A] OK session_established peerLinkId=${aSnap.peerLinkId} thread=${aSnap.threadId} remote=${aSnap.peerAccountId}`);

  log("[B] waiting for session_established...");
  const bSnap = await bWait;
  log(`[B] OK session_established peerLinkId=${bSnap.peerLinkId} thread=${bSnap.threadId} remote=${bSnap.peerAccountId}`);

  // Give a moment for thread/index materialization to settle on both sides.
  await new Promise((r) => setTimeout(r, 1500));

  // ---- Step 5: A → B message ----
  const aThreadId = aSnap.threadId;
  const bThreadId = bSnap.threadId;
  if (!aThreadId || !bThreadId) {
    throw new Error(`missing thread ids — aThread=${aThreadId} bThread=${bThreadId}`);
  }
  const TXT_A2B = "hello-from-alice-" + Date.now();
  log(`[A] >>> message.send "${TXT_A2B}" (thread=${aThreadId})`);
  const bGotAtoB = waitForEvent(
    B.chatServer.bus,
    "message.deposited",
    (p) => {
      const msg = p && p.message ? p.message : {};
      return msg.text === TXT_A2B;
    },
    25000,
    "B receives A's message",
  );
  try {
    const sendRes = await A.chatServer.bus.call("message", "send", {
      threadId: aThreadId,
      payload: { kind: "rez.chat.message.v1", text: TXT_A2B },
      messageId: "ca_1",
    });
    log(`[A] <<< message.send OK messageId=${sendRes.messageId}`);
  } catch (err) {
    log("[A] !!! message.send FAILED:", err && err.message);
    bGotAtoB.catch(() => {});
    throw err;
  }
  log("[B] waiting for A's message to land...");
  await bGotAtoB;
  log("[B] OK received A's message");

  // ---- Step 6: B → A message ----
  const TXT_B2A = "hello-back-from-bob-" + Date.now();
  log(`[B] >>> message.send "${TXT_B2A}" (thread=${bThreadId})`);
  const aGotBtoA = waitForEvent(
    A.chatServer.bus,
    "message.deposited",
    (p) => {
      const msg = p && p.message ? p.message : {};
      return msg.text === TXT_B2A;
    },
    25000,
    "A receives B's message",
  );
  try {
    const sendRes = await B.chatServer.bus.call("message", "send", {
      threadId: bThreadId,
      payload: { kind: "rez.chat.message.v1", text: TXT_B2A },
      messageId: "cb_1",
    });
    log(`[B] <<< message.send OK messageId=${sendRes.messageId}`);
  } catch (err) {
    log("[B] !!! message.send FAILED:", err && err.message);
    aGotBtoA.catch(() => {});
    throw err;
  }
  log("[A] waiting for B's message to land...");
  await aGotBtoA;
  log("[A] OK received B's message");

  log("=== ALL GREEN — bidirectional cross-node messaging works ===");

  try { await A.stop(); } catch (err) { log("[A] stop err:", err && err.message); }
  try { await B.stop(); } catch (err) { log("[B] stop err:", err && err.message); }
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(0);
}

main().catch((err) => {
  console.error("=== TWO-NODE REAL TEST FAILED ===");
  console.error(err && err.stack ? err.stack : err);
  // Leave data dirs in place for forensic inspection.
  console.error("data root preserved at:", ROOT);
  process.exit(1);
});
