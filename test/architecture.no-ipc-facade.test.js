import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DesktopSupervisor } from "../src/desktop/runtime/DesktopSupervisor.js";
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
  // Canonical location since the Tauri migration; electron/runtime/ holds a
  // re-export stub. Both the Electron IPC path and the sidecar's control
  // uplink register channels through this one file.
  const file = path.join(CHAT_ROOT, "src/desktop/runtime/registerDesktopIpc.js");
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

test("guardrail: sidecar crypto channels stay a fixed primitive allowlist", () => {
  const file = path.join(CHAT_ROOT, "src/desktop/runtime/registerDesktopCryptoChannels.js");
  const src = fs.readFileSync(file, "utf8");
  const handles = [...src.matchAll(/ipcMain\.handle\(\s*["']([^"']+)["']/g)].map((m) => m[1]);
  const allowed = new Set([
    "desktop:generateSigningKeyPair",
    "desktop:sign",
    "desktop:verify",
    "desktop:dhGenerateKeyPair",
    "desktop:dhDerive",
    "desktop:scrypt",
  ]);
  for (const channel of handles) {
    assert.ok(
      allowed.has(channel),
      "Forbidden hand-coded channel `" + channel + "` in registerDesktopCryptoChannels. "
      + "Only crypto primitives belong here; bus directives MUST flow through `bus:call`. "
      + "See CLAUDE.md §3 Transport Generality."
    );
  }
});

test("guardrail: control transport files do not enumerate chat directives", () => {
  // The control uplink and sidecar entry must stay generic over the bus
  // protocol: channels arrive via registerDesktopIpc, directives via
  // `bus:call`. A literal "namespace.directive" string in these files means
  // someone reintroduced a per-directive facade on the new transport.
  const files = [
    "src/desktop/transport/DesktopControlUplink.js",
    "src/desktop/sidecar-main.js",
    "src/ui/desktop/installRezDesktopShim.js",
    "src/ui/desktop/ControlChannelClient.js",
  ];
  const directivePattern = /["'](session|threads|message|messages|invites|groups|contacts|channels|peerlink|profile)\.[a-zA-Z][a-zA-Z0-9]*["']/g;
  for (const rel of files) {
    const src = fs.readFileSync(path.join(CHAT_ROOT, rel), "utf8");
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    const hits = [...stripped.matchAll(directivePattern)].map((m) => m[0]);
    assert.deepEqual(
      hits,
      [],
      rel + " enumerates bus directives (" + hits.join(", ") + "). "
      + "All chat directives MUST flow through the generic `bus:call` channel. "
      + "See CLAUDE.md §3 Transport Generality."
    );
  }
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
