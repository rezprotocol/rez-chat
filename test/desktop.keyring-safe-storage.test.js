import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";

import {
  KeyringSafeStorage,
  DeviceUnlockResetRequiredError,
} from "../src/desktop/runtime/KeyringSafeStorage.js";
import { DesktopVaultService } from "../src/desktop/runtime/DesktopVaultService.js";

function tmpPath(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rez-keyring-safe-"));
  return path.join(dir, name);
}

function fakeHostChannel(keyBytes) {
  return {
    requests: [],
    async request(op, params) {
      this.requests.push({ op, params });
      if (op === "keychain.getOrCreateDeviceKey") {
        return { keyB64: Buffer.from(keyBytes).toString("base64") };
      }
      throw new Error("unexpected op " + op);
    },
  };
}

/** Electron-safeStorage stand-in: unprefixed ciphertexts (the legacy shape). */
function legacyElectronSafeStorage() {
  return {
    isEncryptionAvailable() {
      return true;
    },
    encryptString(value) {
      return Buffer.from("v10legacy:" + value, "utf8");
    },
    decryptString(value) {
      const text = Buffer.from(value).toString("utf8");
      return text.startsWith("v10legacy:") ? text.slice("v10legacy:".length) : "";
    },
  };
}

test("keyring safe storage round-trips strings and rejects tampering", async () => {
  const key = randomBytes(32);
  const storage = await KeyringSafeStorage.create({
    hostChannel: fakeHostChannel(key),
    available: true,
  });
  assert.equal(storage.isEncryptionAvailable(), true);
  // No keychain access until opt-in: the key is fetched only on ensureDeviceKey.
  await storage.ensureDeviceKey();

  const wrapped = storage.encryptString("hunter2 — with unicode ✓");
  assert.ok(Buffer.isBuffer(wrapped));
  assert.equal(storage.decryptString(wrapped), "hunter2 — with unicode ✓");

  // Same plaintext encrypts differently (fresh IV per call).
  const wrappedAgain = storage.encryptString("hunter2 — with unicode ✓");
  assert.notDeepEqual(wrapped, wrappedAgain);

  // Bit-flip inside the ciphertext fails the GCM tag.
  const tampered = Buffer.from(wrapped);
  tampered[tampered.length - 1] ^= 0x01;
  assert.throws(() => storage.decryptString(tampered));
});

test("keyring safe storage flags legacy Electron blobs with a typed error", async () => {
  const storage = await KeyringSafeStorage.create({
    hostChannel: fakeHostChannel(randomBytes(32)),
    available: true,
  });
  await storage.ensureDeviceKey();
  const legacyBlob = legacyElectronSafeStorage().encryptString("old secret");
  assert.throws(
    () => storage.decryptString(legacyBlob),
    (err) => err instanceof DeviceUnlockResetRequiredError
      && err.code === "DEVICE_UNLOCK_RESET_REQUIRED",
  );
});

test("keyring safe storage is unavailable when the boot probe reports no backend", async () => {
  // available:false models UserEnvironment's keychain.probe finding no usable
  // backend (e.g. a Linux box with no Secret Service).
  const storage = await KeyringSafeStorage.create({
    hostChannel: fakeHostChannel(randomBytes(32)),
    available: false,
  });
  assert.equal(storage.isEncryptionAvailable(), false);
  assert.throws(() => storage.encryptString("x"), /unavailable/);
  await assert.rejects(() => storage.ensureDeviceKey(), /keychain unavailable/);
});

test("keyring safe storage surfaces a key-fetch failure only on opt-in", async () => {
  // Probe said available, but the deferred getOrCreateDeviceKey fails (e.g.
  // the user denied the keychain prompt). isEncryptionAvailable stays true;
  // the failure surfaces lazily, never at boot.
  const storage = await KeyringSafeStorage.create({
    hostChannel: {
      async request() {
        throw new Error("keychain locked");
      },
    },
    available: true,
  });
  assert.equal(storage.isEncryptionAvailable(), true);
  await assert.rejects(() => storage.ensureDeviceKey(), /keychain locked/);
});

test("vault device unlock works end-to-end on keyring safe storage", async () => {
  const storage = await KeyringSafeStorage.create({
    hostChannel: fakeHostChannel(randomBytes(32)),
    available: true,
  });
  const vault = new DesktopVaultService({
    dbPath: tmpPath("vault.sqlite"),
    safeStorage: storage,
  }).open();

  const created = await vault.createAccount({
    profileName: "Keyring Kate",
    password: "correct horse battery staple",
  });
  await vault.enableDeviceUnlock({ accountId: created.accountId, password: "correct horse battery staple" });
  assert.equal(vault.listAccounts()[0].deviceUnlockEnabled, true);
  vault.lock();

  const unlocked = await vault.unlockWithDevice({ accountId: created.accountId });
  assert.equal(unlocked.accountId, created.accountId);
  vault.close();
});

test("electron-era vault heals on first password unlock and clears dead device unlock", async () => {
  const dbPath = tmpPath("vault.sqlite");
  const password = "correct horse battery staple";

  // 1. Account created under Electron: legacy safeStorage wraps both the
  //    app-data key and the device-unlock password.
  const electronVault = new DesktopVaultService({
    dbPath,
    safeStorage: legacyElectronSafeStorage(),
  }).open();
  const created = await electronVault.createAccount({
    profileName: "Migrating Mia",
    password,
  });
  await electronVault.enableDeviceUnlock({ accountId: created.accountId, password });
  assert.equal(electronVault.listAccounts()[0].deviceUnlockEnabled, true);
  electronVault.close();

  // 2. Same vault.db opened under Tauri (KeyringSafeStorage, fresh key).
  const storage = await KeyringSafeStorage.create({
    hostChannel: fakeHostChannel(randomBytes(32)),
    available: true,
  });
  const tauriVault = new DesktopVaultService({ dbPath, safeStorage: storage }).open();

  // Device unlock fails with the typed reset error and clears enrollment.
  await assert.rejects(
    () => tauriVault.unlockWithDevice({ accountId: created.accountId }),
    (err) => err && err.code === "DEVICE_UNLOCK_RESET_REQUIRED",
  );
  assert.equal(tauriVault.listAccounts()[0].deviceUnlockEnabled, false);

  // Password unlock MUST still work (no lockout) and heals the OS wrap.
  const unlocked = await tauriVault.unlock({ accountId: created.accountId, password });
  assert.equal(unlocked.accountId, created.accountId);
  assert.equal(tauriVault.getAppDataKeyBytes().length, 32);
  tauriVault.lock();

  // 3. Healed row: re-enabling device unlock under the new scheme works.
  await tauriVault.unlock({ accountId: created.accountId, password });
  await tauriVault.enableDeviceUnlock({ accountId: created.accountId, password });
  tauriVault.lock();
  const reUnlocked = await tauriVault.unlockWithDevice({ accountId: created.accountId });
  assert.equal(reUnlocked.accountId, created.accountId);
  tauriVault.close();
});
