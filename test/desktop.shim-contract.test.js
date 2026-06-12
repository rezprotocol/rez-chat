import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHAT_ROOT = path.resolve(__dirname, "..");

/**
 * Contract: the Tauri rezDesktop shim exposes EXACTLY the surface
 * electron/preload.cjs exposes. The UI is written against this surface; a
 * key missing from either transport is a silent feature break on that
 * shell. One list, asserted against both implementations.
 */
const TOP_LEVEL_KEYS = [
  "platform",
  "getAppInfo",
  "openExternal",
  "generateSigningKeyPair",
  "sign",
  "verify",
  "dhGenerateKeyPair",
  "dhDerive",
  "scrypt",
  "vault",
  "environment",
  "backup",
  "runtime",
  "bus",
  "updates",
];
const ENVIRONMENT_KEYS = ["capabilities"];
const VAULT_KEYS = [
  "status",
  "createAccount",
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
];
const BACKUP_KEYS = ["saveToFile", "openFile"];
const RUNTIME_KEYS = ["connect", "disconnect", "status"];
const BUS_KEYS = ["call", "on"];
const UPDATES_KEYS = ["onStatus", "getStatus", "restartAndInstall"];

function installFakeBrowserGlobals() {
  class FakeWebSocket {
    constructor() {
      this.onopen = null;
      this.onmessage = null;
      this.onclose = null;
      this.onerror = null;
      this.readyState = 0;
    }

    send() {}

    close() {}
  }
  FakeWebSocket.OPEN = 1;
  globalThis.WebSocket = FakeWebSocket;
  globalThis.document = {
    readyState: "loading",
    addEventListener() {},
  };
  globalThis.window = {
    __REZ_TAURI_BOOTSTRAP__: {
      platform: "darwin",
      appVersion: "0.0.0-test",
      shellPort: 34567,
      controlToken: "contract-test-token",
    },
  };
}

test("tauri shim reproduces the preload rezDesktop surface exactly", async () => {
  installFakeBrowserGlobals();
  await import("../src/ui/desktop/installRezDesktopShim.js");
  const shim = globalThis.window.rezDesktop;
  assert.ok(shim, "shim must install when __REZ_TAURI_BOOTSTRAP__ is present");

  assert.deepEqual(Object.keys(shim).sort(), [...TOP_LEVEL_KEYS].sort());
  assert.deepEqual(Object.keys(shim.vault).sort(), [...VAULT_KEYS].sort());
  assert.deepEqual(Object.keys(shim.environment).sort(), [...ENVIRONMENT_KEYS].sort());
  assert.deepEqual(Object.keys(shim.backup).sort(), [...BACKUP_KEYS].sort());
  assert.deepEqual(Object.keys(shim.runtime).sort(), [...RUNTIME_KEYS].sort());
  assert.deepEqual(Object.keys(shim.bus).sort(), [...BUS_KEYS].sort());
  assert.deepEqual(Object.keys(shim.updates).sort(), [...UPDATES_KEYS].sort());

  assert.equal(shim.platform, "darwin");
  assert.equal(typeof shim.bus.call, "function");
  const off = shim.bus.on("message.deposited", () => {});
  assert.equal(typeof off, "function");
  off();
});

test("preload exposes the same contract keys (both shells share one surface)", () => {
  const src = fs.readFileSync(path.join(CHAT_ROOT, "electron/preload.cjs"), "utf8");
  for (const key of TOP_LEVEL_KEYS) {
    const pattern = new RegExp("\\b" + key + "\\s*:");
    assert.ok(pattern.test(src), "preload.cjs missing top-level key '" + key + "'");
  }
  for (const key of VAULT_KEYS) {
    const pattern = new RegExp("\\b" + key + "\\s*:");
    assert.ok(pattern.test(src), "preload.cjs missing vault key '" + key + "'");
  }
});

test("shim does not install without the Tauri bootstrap (Electron/browser path)", async () => {
  // Module is cached from the first test; exercise the exported function.
  const { installRezDesktopShim } = await import("../src/ui/desktop/installRezDesktopShim.js");
  globalThis.window = {};
  assert.equal(installRezDesktopShim(), false);
  assert.equal(globalThis.window.rezDesktop, undefined);
});
