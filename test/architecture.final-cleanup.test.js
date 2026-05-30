import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const SRC_DIR = path.resolve(import.meta.dirname, "..", "src");

function readFile(relativePath) {
  return fs.readFileSync(path.join(SRC_DIR, relativePath), "utf8");
}

test("legacy architecture wrapper files are removed", () => {
  const removed = [
    "server/ChatAppServer.js",
    "server/bridge/BridgeClient.js",
    "server/bridge/ChatBridge.js",
    "server/bridge/index.js",
    "server/network/Http.js",
    "server/network/Websocket.js",
    "server/network/index.js",
    "server/shell/startShellServer.js",
    "server/shell/index.js",
    "ui/services/AuthService.js",
    "ui/wiring/resolveKeystoreStore.js",
    "ui/scenes/LoginScene.js",
  ];
  const stillPresent = removed.filter((relativePath) => fs.existsSync(path.join(SRC_DIR, relativePath)));
  assert.deepEqual(stillPresent, [], `Legacy wrapper files still exist:\n${stillPresent.join("\n")}`);
});

test("ChatServerApp is lifecycle-only and does not expose domain proxy methods", () => {
  const content = readFile("server/app/ChatServerApp.js");
  const forbiddenPatterns = [
    "listThreads(",
    "getThread(",
    "listMessages(",
    "markThreadRead(",
    "setThreadState(",
    "sendMessage(",
    "listContacts(",
    "renameContact(",
    "blockContact(",
    "unblockContact(",
    "createInvite(",
    "acceptInvite(",
    "listPeerLinks(",
    "getPeerLink(",
    "getNodeStatus(",
    "getMeshStatus(",
    "createGroup(",
    "listGroups(",
    "listGroupMembers(",
    "putKeystore(",
    "fetchKeystore(",
  ];
  const violations = forbiddenPatterns.filter((pattern) => content.includes(pattern));
  assert.deepEqual(violations, [], `ChatServerApp still exposes domain proxy methods:\n${violations.join("\n")}`);
});

test("server public index exports only new class-based architecture surfaces", () => {
  const content = readFile("server/index.js");
  const forbidden = [
    "ChatAppServer",
    "startShellServer",
    "attachChatBridgeWebsocketUplink",
    "./shell/index.js",
    "./network/index.js",
  ];
  const violations = forbidden.filter((pattern) => content.includes(pattern));
  assert.deepEqual(violations, [], `server/index.js still references legacy surfaces:\n${violations.join("\n")}`);
});

test("client auth scene surface uses split login scenes and no scene-local mode switching", () => {
  // The split scenes must exist as concrete files; the obsolete unified
  // LoginScene must NOT exist. (Previously this read the scenes barrel;
  // barrels were deleted as dead weight — concrete-file checks are the
  // policy now.)
  assert.equal(fs.existsSync(path.join(SRC_DIR, "ui/scenes/LoginUnlockScene.js")), true);
  assert.equal(fs.existsSync(path.join(SRC_DIR, "ui/scenes/LoginCreateAccountScene.js")), true);
  assert.equal(fs.existsSync(path.join(SRC_DIR, "ui/scenes/LoginScene.js")), false);
});
