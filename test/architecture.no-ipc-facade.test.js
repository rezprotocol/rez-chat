import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DesktopSupervisor } from "../electron/runtime/DesktopSupervisor.mjs";
import { DesktopRuntimeClient } from "../src/client/runtime/DesktopRuntimeClient.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHAT_ROOT = path.resolve(__dirname, "..");

/**
 * Architecture guardrail: forbid the per-bus-directive facade anti-pattern in
 * the desktop transport layer. See feedback_no_ipc_facades.md and
 * CLAUDE.md §3 "Transport Generality" for the rule and the war story.
 *
 * Why these checks: a hand-coded 10-name event-forward array in
 * DesktopSupervisor drifted from CHAT_BRIDGE_SPEC.events on 2026-05-17 and
 * silently dropped every bus event for two real users. The structural fix
 * collapsed the facade to a generic `bus:call` / `bus:event` bridge. These
 * tests fail CI if anyone reintroduces the facade.
 */

test("guardrail: preload exposes no per-directive chat namespace", () => {
  const file = path.join(CHAT_ROOT, "electron/preload.cjs");
  const src = fs.readFileSync(file, "utf8");
  assert.equal(
    src.match(/\bchat\s*:\s*\{/),
    null,
    "electron/preload.cjs reintroduces a `chat: { ... }` facade. "
    + "Use `rezDesktop.bus.call(method, params)` and `rezDesktop.bus.on(event, handler)` instead. "
    + "See CLAUDE.md §3 Transport Generality."
  );
});

test("guardrail: registerDesktopIpc registers only generic + lifecycle IPC handlers", () => {
  const file = path.join(CHAT_ROOT, "electron/runtime/registerDesktopIpc.mjs");
  const src = fs.readFileSync(file, "utf8");
  const handles = [...src.matchAll(/ipcMain\.handle\(\s*["']([^"']+)["']/g)].map((m) => m[1]);
  const allowed = new Set([
    "bus:call",
    "desktop:vault:status",
    "desktop:vault:createAccount",
    "desktop:vault:unlock",
    "desktop:vault:unlockWithDevice",
    "desktop:vault:disableDeviceUnlock",
    "desktop:vault:lock",
    "desktop:vault:listAccounts",
    "desktop:vault:getActiveIdentitySummary",
    "desktop:vault:setProfileName",
    "desktop:vault:setAvatarFileHash",
    "desktop:vault:getAvatarFileHash",
    "desktop:vault:setAvatarDataB64",
    "desktop:vault:getAvatarDataB64",
    "desktop:vault:revealMnemonic",
    "desktop:vault:resetPasswordWithMnemonic",
    "desktop:vault:changePassword",
    "desktop:vault:exportBackup",
    "desktop:vault:importBackup",
    "desktop:vault:purgeAccount",
    "desktop:runtime:connect",
    "desktop:runtime:disconnect",
    "desktop:runtime:status",
  ]);
  for (const channel of handles) {
    assert.ok(
      allowed.has(channel),
      "Forbidden hand-coded IPC handler `" + channel + "`. "
      + "Bus directives MUST flow through `bus:call`. Lifecycle channels are "
      + "the only allowed exceptions. See CLAUDE.md §3 Transport Generality."
    );
  }
  // Must include the generic dispatcher.
  assert.ok(handles.includes("bus:call"), "registerDesktopIpc must register `bus:call`");
});

test("guardrail: DesktopSupervisor does not enumerate bus directives as methods", () => {
  const publicMethods = Object.getOwnPropertyNames(DesktopSupervisor.prototype)
    .filter((name) => name !== "constructor" && !name.startsWith("_") && !name.startsWith("#"));
  const allowed = new Set([
    "start",
    "stop",
    "status",
    "vaultStatus",
    "createAccount",
    "noteVaultActivity",
    "unlock",
    "unlockWithDevice",
    "disableDeviceUnlock",
    "lock",
    "listAccounts",
    "getActiveIdentitySummary",
    "setProfileName",
    "setAvatarFileHash",
    "getAvatarFileHash",
    "setAvatarDataB64",
    "getAvatarDataB64",
    "revealMnemonic",
    "resetPasswordWithMnemonic",
    "changePassword",
    "exportBackup",
    "importBackup",
    "purgeAccount",
    "connect",
    "disconnect",
    "getBusBridge",
    "onChatAppChange",
  ]);
  for (const method of publicMethods) {
    assert.ok(
      allowed.has(method),
      "DesktopSupervisor." + method + "(...) looks like a bus-directive facade. "
      + "Route the directive through DesktopBusBridge.call(method, params) instead. "
      + "See CLAUDE.md §3 Transport Generality."
    );
  }
});

test("guardrail: DesktopRuntimeClient does not enumerate bus directives as methods", () => {
  const publicMethods = Object.getOwnPropertyNames(DesktopRuntimeClient.prototype)
    .filter((name) => name !== "constructor" && !name.startsWith("_") && !name.startsWith("#"));
  const allowed = new Set([
    "connect",
    "close",
    "disconnect",
    "getSessionInfo",
    "call",
    "onEvent",
    "on",
    "sendRezPayload",
    "listInvites",
    "putKeystore",
    "fetchKeystore",
    "backup",
    "getActiveUplink",
    "getUplinkStates",
    "onState",
  ]);
  for (const method of publicMethods) {
    assert.ok(
      allowed.has(method),
      "DesktopRuntimeClient." + method + "(...) looks like a bus-directive facade. "
      + "UI services must call `client.call(\"namespace.name\", params)` instead. "
      + "See CLAUDE.md §3 Transport Generality."
    );
  }
});
