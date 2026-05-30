/**
 * Real-network two-node integration test for message MUTATIONS via the
 * DesktopBusBridge pipeline.
 *
 * Sibling of desktop.two-user-events.integration.test.js. That test proves the
 * baseline (invite/accept + plain message round-trip). This test proves the
 * five mutation directives flow through the same path:
 *   message.edit, message.tombstone,
 *   message.reaction.add, message.reaction.remove,
 *   message.deleteLocal
 *
 * Specifically, each deposit-backed mutation MUST round-trip through the live
 * relay mesh, decrypt on the receiver, dispatch through ServerEventService's
 * kind-based branches into ServerMessagesService.handleIncoming*, mutate the
 * ChatThreadStore, and emit `message.updated` to the recipient's bridge.
 * `message.deleteLocal` is a local-only directive and must emit
 * `message.removed` ONLY on the actor's bridge.
 *
 * Why this test exists: unit tests cover the store math; this test covers the
 * exact wire/dispatch path that the 2026-05-17 silent-event-drop bug lived in.
 *
 * Gated on `RUN_INTEGRATION=1`. ~25s (12s relay-settle + 6 mutation round-trips).
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

function expectNoEnvelope(bridge, eventName, predicate, windowMs) {
  return new Promise((resolve, reject) => {
    const off = bridge.subscribeEvents((envelope) => {
      if (!envelope || envelope.event !== eventName) return;
      let matched = false;
      try {
        matched = !predicate || predicate(envelope.payload);
      } catch (err) {
        clearTimeout(timer);
        off();
        reject(err);
        return;
      }
      if (matched) {
        clearTimeout(timer);
        off();
        reject(new Error("unexpected " + eventName + " envelope received within " + windowMs + "ms"));
      }
    });
    const timer = setTimeout(() => {
      off();
      resolve();
    }, windowMs);
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
  return {
    chatApp,
    supervisor,
    bridge: supervisor.getBusBridge(),
    accountId: vault.getActiveIdentitySummary().accountId,
  };
}

test("two-node integration: message mutations (edit / tombstone / reactions / deleteLocal) round-trip via DesktopBusBridge",
  { skip: shouldRun ? false : "set RUN_INTEGRATION=1 to enable (uses live relays, ~25s)" },
  async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rez-twonode-mut-"));
    const A_CONFIG = path.join(root, "a.config.json");
    const B_CONFIG = path.join(root, "b.config.json");
    const A_DATA = path.join(root, "a-data");
    const B_DATA = path.join(root, "b-data");
    const A_VAULT = path.join(root, "a-vault.sqlite");
    const B_VAULT = path.join(root, "b-vault.sqlite");
    writeConfig(A_CONFIG, 18823, A_DATA);
    writeConfig(B_CONFIG, 18824, B_DATA);

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

    // ---- Prelude: invite → handshake → baseline message A → B ----
    const invite = await A.bridge.call("invite.create", {
      kind: "direct",
      maxUses: 1,
      creatorDisplayName: "Alice",
    });

    const aPLU = waitForEnvelope(A.bridge, "peer-link.updated",
      (p) => p && (p.state === "session_established" || p.state === "established"),
      "A session_established", 45000);
    const bPLU = waitForEnvelope(B.bridge, "peer-link.updated",
      (p) => p && (p.state === "session_established" || p.state === "established"),
      "B session_established", 45000);

    await B.bridge.call("invite.accept", {
      inviteCode: invite.inviteCode,
      acceptorDisplayName: "Bob",
    });

    const aSnap = await aPLU;
    const bSnap = await bPLU;
    assert.ok(aSnap.threadId, "A peer-link.updated must include threadId");
    assert.ok(bSnap.threadId, "B peer-link.updated must include threadId");
    const threadIdA = aSnap.threadId;
    const threadIdB = bSnap.threadId;
    // peerAccountId is each side's view of the *other* party's peerlink
    // identity. This is the identifier that appears in messages and reactions
    // — distinct from the vault's owner accountId.
    const bPeerAccountId = String(aSnap.peerAccountId || "").trim();
    assert.ok(bPeerAccountId, "A peer-link.updated must carry B's peerlink peerAccountId");

    const TXT = "mut-base-" + Date.now();
    const bGotBase = waitForEnvelope(B.bridge, "message.deposited",
      (p) => p && p.message && p.message.text === TXT,
      "B receives baseline", 25000);
    const sendResult = await A.bridge.call("message.send", {
      threadId: threadIdA,
      payload: { kind: "rez.chat.message.v1", text: TXT },
      messageId: "mut_base_1",
    });
    const bBasePayload = await bGotBase;
    const messageId = sendResult.messageId;
    assert.ok(messageId, "message.send must return messageId");
    assert.equal(bBasePayload.message.messageId, messageId,
      "B's deposited message must share the same messageId as A's send result");

    // ---- 2. Edit: A → B (sender authorized; payload.text is replaced) ----
    const bGotEdit = waitForEnvelope(B.bridge, "message.updated",
      (p) => p && p.message && p.message.messageId === messageId && p.message.text === "EDITED",
      "B receives edit", 25000);
    await A.bridge.call("message.edit", {
      threadId: threadIdA,
      targetMessageId: messageId,
      newText: "EDITED",
    });
    const editPayload = await bGotEdit;
    assert.equal(editPayload.threadId, threadIdB, "edit envelope must carry B's threadId");
    assert.equal(editPayload.message.text, "EDITED", "B must see new text");
    assert.ok(editPayload.message.editedAtMs > 0, "editedAtMs must be set");

    // ---- 3. Reaction add: B → A (👍) ----
    const aGotThumbs = waitForEnvelope(A.bridge, "message.updated",
      (p) => p && p.message && p.message.messageId === messageId
        && p.message.reactions && Array.isArray(p.message.reactions["👍"])
        && p.message.reactions["👍"].includes(bPeerAccountId),
      "A receives 👍 reaction", 25000);
    await B.bridge.call("message.reaction.add", {
      threadId: threadIdB,
      targetMessageId: messageId,
      emoji: "👍",
    });
    await aGotThumbs;

    // ---- 4. Reaction add: B → A (❤️) — multi-emoji per user ----
    const aGotHeart = waitForEnvelope(A.bridge, "message.updated",
      (p) => {
        if (!p || !p.message || p.message.messageId !== messageId) return false;
        const r = p.message.reactions || {};
        return Array.isArray(r["👍"]) && r["👍"].includes(bPeerAccountId)
          && Array.isArray(r["❤️"]) && r["❤️"].includes(bPeerAccountId);
      },
      "A receives ❤️ reaction with 👍 still present", 25000);
    await B.bridge.call("message.reaction.add", {
      threadId: threadIdB,
      targetMessageId: messageId,
      emoji: "❤️",
    });
    await aGotHeart;

    // ---- 5. Reaction remove: B → A (remove 👍, keep ❤️) ----
    const aGotRemove = waitForEnvelope(A.bridge, "message.updated",
      (p) => {
        if (!p || !p.message || p.message.messageId !== messageId) return false;
        const r = p.message.reactions || {};
        const noThumbs = !r["👍"] || r["👍"].length === 0;
        const heartStill = Array.isArray(r["❤️"]) && r["❤️"].includes(bPeerAccountId);
        return noThumbs && heartStill;
      },
      "A receives 👍 removal with ❤️ intact", 25000);
    await B.bridge.call("message.reaction.remove", {
      threadId: threadIdB,
      targetMessageId: messageId,
      emoji: "👍",
    });
    await aGotRemove;

    // ---- 6. Tombstone: A → B (text cleared, tombstonedAtMs set) ----
    const bGotTomb = waitForEnvelope(B.bridge, "message.updated",
      (p) => p && p.message && p.message.messageId === messageId
        && p.message.tombstonedAtMs > 0
        && (!p.message.text || p.message.text.length === 0),
      "B receives tombstone", 25000);
    await A.bridge.call("message.tombstone", {
      threadId: threadIdA,
      targetMessageId: messageId,
    });
    await bGotTomb;

    // ---- 7. Local delete: B only — A must NOT see message.removed ----
    const bGotRemoved = waitForEnvelope(B.bridge, "message.removed",
      (p) => p && p.messageId === messageId,
      "B receives local message.removed", 10000);
    const aMustNotSeeRemoved = expectNoEnvelope(A.bridge, "message.removed",
      (p) => p && p.messageId === messageId,
      3000);
    await B.bridge.call("message.deleteLocal", {
      threadId: threadIdB,
      targetMessageId: messageId,
    });
    await bGotRemoved;
    await aMustNotSeeRemoved;
  });
