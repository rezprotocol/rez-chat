import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DesktopVaultService } from "../electron/runtime/DesktopVaultService.mjs";

function tmpPath(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rez-desktop-vault-"));
  return path.join(dir, name);
}

function createSafeStorage() {
  return {
    isEncryptionAvailable() {
      return true;
    },
    encryptString(value) {
      return Buffer.from("wrapped:" + value, "utf8");
    },
    decryptString(value) {
      const text = Buffer.from(value).toString("utf8");
      return text.startsWith("wrapped:") ? text.slice("wrapped:".length) : "";
    },
  };
}

test("desktop vault creates, locks, unlocks, and rejects wrong passwords", async () => {
  const dbPath = tmpPath("vault.sqlite");
  const vault = new DesktopVaultService({
    dbPath,
    safeStorage: createSafeStorage(),
  }).open();

  const created = await vault.createAccount({
    profileName: "Ada Lovelace",
    password: "correct horse battery staple",
  });
  assert.equal(typeof created.accountId, "string");
  assert.equal(vault.status().locked, false);
  assert.equal(vault.listAccounts().length, 1);

  const keyBytes = vault.getAppDataKeyBytes();
  assert.equal(keyBytes.length, 32);

  vault.lock();
  assert.equal(vault.status().locked, true);
  assert.throws(() => vault.getAppDataKeyBytes(), /locked/i);

  await assert.rejects(
    () => vault.unlock({ accountId: created.accountId, password: "bad password" }),
    /decrypt|password|unlock|OperationError|integrity/i,
  );

  const unlocked = await vault.unlock({
    accountId: created.accountId,
    password: "correct horse battery staple",
  });
  assert.equal(unlocked.accountId, created.accountId);
  assert.equal(vault.status().locked, false);
  vault.close();
});

test("desktop vault device-unlock round-trips via wrapped password", async () => {
  const dbPath = tmpPath("vault.sqlite");
  const vault = new DesktopVaultService({
    dbPath,
    safeStorage: createSafeStorage(),
  }).open();

  const created = await vault.createAccount({
    profileName: "Grace Hopper",
    password: "compile this",
  });
  assert.equal(vault.listAccounts()[0].deviceUnlockEnabled, false);

  vault.enableDeviceUnlock({ accountId: created.accountId, password: "compile this" });
  assert.equal(vault.listAccounts()[0].deviceUnlockEnabled, true);

  vault.lock();
  const unlocked = await vault.unlockWithDevice({ accountId: created.accountId });
  assert.equal(unlocked.accountId, created.accountId);
  assert.equal(vault.status().locked, false);

  vault.lock();
  vault.disableDeviceUnlock({ accountId: created.accountId });
  assert.equal(vault.listAccounts()[0].deviceUnlockEnabled, false);
  await assert.rejects(
    () => vault.unlockWithDevice({ accountId: created.accountId }),
    /device unlock not enabled/i,
  );
  vault.close();
});

test("desktop vault unlock with enableDeviceUnlock flag wraps password atomically", async () => {
  const dbPath = tmpPath("vault.sqlite");
  const vault = new DesktopVaultService({
    dbPath,
    safeStorage: createSafeStorage(),
  }).open();

  const created = await vault.createAccount({
    profileName: "Alan Turing",
    password: "halting problem",
  });
  vault.lock();

  await vault.unlock({
    accountId: created.accountId,
    password: "halting problem",
    enableDeviceUnlock: true,
  });
  assert.equal(vault.listAccounts()[0].deviceUnlockEnabled, true);

  vault.lock();
  const unlocked = await vault.unlockWithDevice({ accountId: created.accountId });
  assert.equal(unlocked.accountId, created.accountId);
  vault.close();
});

test("desktop vault device-unlock requires safeStorage availability", async () => {
  const dbPath = tmpPath("vault.sqlite");
  const vault = new DesktopVaultService({
    dbPath,
    safeStorage: {
      isEncryptionAvailable() { return false; },
      encryptString() { throw new Error("unavailable"); },
      decryptString() { throw new Error("unavailable"); },
    },
  }).open();
  const created = await vault.createAccount({
    profileName: "Linus",
    password: "kernel panic",
  });
  assert.throws(
    () => vault.enableDeviceUnlock({ accountId: created.accountId, password: "kernel panic" }),
    /OS encryption not available/i,
  );
  await assert.rejects(
    () => vault.unlockWithDevice({ accountId: created.accountId }),
    /OS encryption not available/i,
  );
  vault.close();
});

test("desktop vault does not store password plaintext", async () => {
  // The profile name IS stored plaintext as `profileNameHint` so the account
  // picker can label accounts before unlock. Passwords and keystore material
  // must remain encrypted at rest.
  const dbPath = tmpPath("vault.sqlite");
  const vault = new DesktopVaultService({
    dbPath,
    safeStorage: createSafeStorage(),
  }).open();

  await vault.createAccount({
    profileName: "Private Profile Name",
    password: "private password value",
  });
  vault.close();

  const raw = fs.readFileSync(dbPath);
  assert.equal(raw.includes(Buffer.from("private password value")), false);
});

test("desktop vault setProfileName persists across lock/unlock and beats keystore seed", async () => {
  const dbPath = tmpPath("vault.sqlite");
  const vault = new DesktopVaultService({
    dbPath,
    safeStorage: createSafeStorage(),
  }).open();

  const created = await vault.createAccount({
    profileName: "Original",
    password: "vault-pass-12345",
  });
  assert.equal(vault.getActiveIdentitySummary().profileName, "Original");
  assert.equal(vault.listAccounts()[0].label, "Original");

  vault.setProfileName({ accountId: created.accountId, profileName: "Renamed Here" });
  assert.equal(vault.getActiveIdentitySummary().profileName, "Renamed Here");
  assert.equal(vault.listAccounts()[0].label, "Renamed Here");

  vault.lock();
  const unlocked = await vault.unlock({
    accountId: created.accountId,
    password: "vault-pass-12345",
  });
  // Hint must win over the keystore-seeded profileName ("Original").
  assert.equal(unlocked.profileName, "Renamed Here");
  assert.equal(vault.listAccounts()[0].label, "Renamed Here");
  vault.close();
});

test("desktop vault setProfileName rejects empty names and unknown accounts", async () => {
  const dbPath = tmpPath("vault.sqlite");
  const vault = new DesktopVaultService({
    dbPath,
    safeStorage: createSafeStorage(),
  }).open();
  const created = await vault.createAccount({
    profileName: "Initial",
    password: "vault-pass-12345",
  });
  assert.throws(
    () => vault.setProfileName({ accountId: created.accountId, profileName: "  " }),
    /non-empty profileName/i,
  );
  assert.throws(
    () => vault.setProfileName({ accountId: "rez:acct:missing", profileName: "Whatever" }),
    /No vault account found/i,
  );
  vault.close();
});

test("desktop vault avatar setters and getters round-trip per account", async () => {
  const dbPath = tmpPath("vault.sqlite");
  const vault = new DesktopVaultService({
    dbPath,
    safeStorage: createSafeStorage(),
  }).open();
  const created = await vault.createAccount({
    profileName: "AvatarUser",
    password: "vault-pass-12345",
  });
  assert.equal(vault.getAvatarFileHash({ accountId: created.accountId }).avatarFileHash, "");
  assert.equal(vault.getAvatarDataB64({ accountId: created.accountId }).avatarDataB64, "");

  vault.setAvatarFileHash({ accountId: created.accountId, avatarFileHash: "sha256:abcdef" });
  vault.setAvatarDataB64({ accountId: created.accountId, avatarDataB64: "AAAA" });
  assert.equal(vault.getAvatarFileHash({ accountId: created.accountId }).avatarFileHash, "sha256:abcdef");
  assert.equal(vault.getAvatarDataB64({ accountId: created.accountId }).avatarDataB64, "AAAA");

  vault.lock();
  await vault.unlock({ accountId: created.accountId, password: "vault-pass-12345" });
  assert.equal(vault.getAvatarFileHash({ accountId: created.accountId }).avatarFileHash, "sha256:abcdef");
  assert.equal(vault.getAvatarDataB64({ accountId: created.accountId }).avatarDataB64, "AAAA");

  vault.setAvatarFileHash({ accountId: created.accountId, avatarFileHash: "" });
  vault.setAvatarDataB64({ accountId: created.accountId, avatarDataB64: "" });
  assert.equal(vault.getAvatarFileHash({ accountId: created.accountId }).avatarFileHash, "");
  assert.equal(vault.getAvatarDataB64({ accountId: created.accountId }).avatarDataB64, "");
  vault.close();
});
