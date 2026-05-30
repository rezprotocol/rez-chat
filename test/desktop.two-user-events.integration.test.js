/**
 * Real-network two-node integration test for the DesktopBusBridge pipeline.
 *
 * Spins up TWO independent chat-servers, each with its own rez-node, both
 * connecting to the live DO relay mesh, both driven through DesktopSupervisor
 * + DesktopBusBridge (the exact path the packaged desktop app uses). Verifies
 * that invite/accept produces the canonical bus event sequence on BOTH sides:
 *   peer-link.updated (state=session_established)
 *   thread.index.updated
 *   contact.updated
 *   message.deposited (round-trip)
 *
 * Why this test exists: the mocked desktop two-user smoke test (deleted in
 * the same change as this addition) hid a real bug — the hand-coded event
 * forward array drifted from the spec and silently dropped every event for
 * two real users. This test would have caught it. NEVER rely on mocked
 * versions of the network or supervisor for desktop coverage.
 *
 * Gated on `RUN_INTEGRATION=1`. The test takes ~15 seconds (12s relay-settle
 * + ~2s round-trip).
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { startRezChat } from "../src/index.js";
import { createDefaultRezConfig } from "../src/server/config/defaultRezConfig.js";
import { DesktopSupervisor } from "../electron/runtime/DesktopSupervisor.mjs";
import { DesktopVaultService } from "../electron/runtime/DesktopVaultService.mjs";

const shouldRun = String(process.env.RUN_INTEGRATION || "").trim() === "1";

function writeConfig(filePath, wsPort, dataDir) {
  const cfg = createDefaultRezConfig({ dataDir });
  cfg.node.ws.port = wsPort;
  cfg.node.ws.host = "127.0.0.1";
  fs.writeFileSync(filePath, JSON.stringify(cfg, null, 2));
}

function createSafeStorage() {
  return {
    isEncryptionAvailable() { return true; },
    encryptString(value) { return Buffer.from("wrapped:" + value, "utf8"); },
    decryptString(value) {
      const text = Buffer.from(value).toString("utf8");
      return text.startsWith("wrapped:") ? text.slice("wrapped:".length) : "";
    },
  };
}

function waitForEnvelope(bridge, eventName, predicate, label, timeoutMs) {
  return new Promise((resolve, reject) => {
    let off = null;
    const timer = setTimeout(() => {
      if (off) off();
      reject(new Error("timeout (" + timeoutMs + "ms) waiting for " + eventName + " — " + label));
    }, timeoutMs);
    off = bridge.subscribeEvents((envelope) => {
      if (!envelope || envelope.event !== eventName) return;
      let matched = false;
      try {
        matched = !predicate || predicate(envelope.payload);
      } catch (err) {
        clearTimeout(timer);
        if (off) off();
        reject(err);
        return;
      }
      if (matched) {
        clearTimeout(timer);
        if (off) off();
        resolve(envelope.payload);
      }
    });
  });
}

async function createSide(label, configPath, vaultPath) {
  const chatApp = await startRezChat({
    configPath,
    shellPort: 0,
    shellHost: "127.0.0.1",
    skipUiRootCheck: true,
  });
  const vault = new DesktopVaultService({
    dbPath: vaultPath,
    safeStorage: createSafeStorage(),
  }).open();
  await vault.createAccount({ profileName: label, password: "test-test" });
  const supervisor = new DesktopSupervisor({
    vault,
    chatApp,
    logger: { log() {}, info() {}, warn() {}, error() {} },
  });
  await supervisor.start();
  await supervisor.unlock({
    accountId: vault.getActiveIdentitySummary().accountId,
    password: "test-test",
  });
  await supervisor.connect();
  return { chatApp, supervisor, bridge: supervisor.getBusBridge() };
}

test("two-node integration: full invite → handshake → bidirectional messaging via DesktopBusBridge",
  { skip: shouldRun ? false : "set RUN_INTEGRATION=1 to enable (uses live relays, ~15s)" },
  async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rez-twonode-int-"));
    const A_CONFIG = path.join(root, "a.config.json");
    const B_CONFIG = path.join(root, "b.config.json");
    const A_DATA = path.join(root, "a-data");
    const B_DATA = path.join(root, "b-data");
    const A_VAULT = path.join(root, "a-vault.sqlite");
    const B_VAULT = path.join(root, "b-vault.sqlite");
    writeConfig(A_CONFIG, 18821, A_DATA);
    writeConfig(B_CONFIG, 18822, B_DATA);

    const A = await createSide("A", A_CONFIG, A_VAULT);
    const B = await createSide("B", B_CONFIG, B_VAULT);

    t.after(async () => {
      await A.supervisor.stop().catch(() => {});
      await B.supervisor.stop().catch(() => {});
      await A.chatApp.stop().catch(() => {});
      await B.chatApp.stop().catch(() => {});
      fs.rmSync(root, { recursive: true, force: true });
    });

    // Settle: relay register + DHT publish.
    await new Promise((r) => setTimeout(r, 12000));

    // A creates invite via bridge.call (the generic dispatch path).
    const invite = await A.bridge.call("invite.create", {
      kind: "direct",
      maxUses: 1,
      creatorDisplayName: "Alice",
    });
    assert.ok(invite && typeof invite.inviteCode === "string" && invite.inviteCode.length > 0,
      "invite.create must return an inviteCode");

    // Wait for session_established on both bridges (the events that hide bugs).
    const aPLU = waitForEnvelope(A.bridge, "peer-link.updated",
      (p) => p && (p.state === "session_established" || p.state === "established"),
      "A session_established", 45000);
    const bPLU = waitForEnvelope(B.bridge, "peer-link.updated",
      (p) => p && (p.state === "session_established" || p.state === "established"),
      "B session_established", 45000);
    const aTIU = waitForEnvelope(A.bridge, "thread.index.updated", () => true, "A thread.index.updated", 45000);
    const bTIU = waitForEnvelope(B.bridge, "thread.index.updated", () => true, "B thread.index.updated", 45000);
    const aCU = waitForEnvelope(A.bridge, "contact.updated", () => true, "A contact.updated", 45000);
    const bCU = waitForEnvelope(B.bridge, "contact.updated", () => true, "B contact.updated", 45000);

    // B accepts via bridge.call.
    const acceptResult = await B.bridge.call("invite.accept", {
      inviteCode: invite.inviteCode,
      acceptorDisplayName: "Bob",
    });
    assert.ok(acceptResult && typeof acceptResult.state === "string", "invite.accept must return a state");

    const aSnap = await aPLU;
    const bSnap = await bPLU;
    assert.ok(aSnap.threadId, "A must receive a peer-link.updated with threadId");
    assert.ok(bSnap.threadId, "B must receive a peer-link.updated with threadId");

    await aTIU;
    await bTIU;
    await aCU;
    await bCU;

    // Round-trip message A → B.
    const TXT_A2B = "int-A2B-" + Date.now();
    const bGot = waitForEnvelope(B.bridge, "message.deposited",
      (p) => p && p.message && p.message.text === TXT_A2B,
      "B receives A's message", 25000);
    await A.bridge.call("message.send", {
      threadId: aSnap.threadId,
      payload: { kind: "rez.chat.message.v1", text: TXT_A2B },
      messageId: "int_ca_1",
    });
    await bGot;

    // Round-trip message B → A.
    const TXT_B2A = "int-B2A-" + Date.now();
    const aGot = waitForEnvelope(A.bridge, "message.deposited",
      (p) => p && p.message && p.message.text === TXT_B2A,
      "A receives B's message", 25000);
    await B.bridge.call("message.send", {
      threadId: bSnap.threadId,
      payload: { kind: "rez.chat.message.v1", text: TXT_B2A },
      messageId: "int_cb_1",
    });
    await aGot;
  });
