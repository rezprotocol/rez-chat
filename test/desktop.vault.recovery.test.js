// Phase 2 — BIP39-rooted vault tests. All un-mocked (real scrypt, real
// ed25519, real better-sqlite3) per the no-mocked-crypto invariant.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { Identity } from "@rezprotocol/sdk/client";
import { Bip39 } from "@rezprotocol/sdk/crypto/bip39";
import { SeedKeys } from "@rezprotocol/sdk/crypto/seedDerivation";
import { DesktopVaultService } from "../electron/runtime/DesktopVaultService.mjs";

function tmpPath(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rez-vault-bip39-"));
  return path.join(dir, name);
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

function openVault() {
  return new DesktopVaultService({
    dbPath: tmpPath("vault.sqlite"),
    safeStorage: createSafeStorage(),
  }).open();
}

test("createAccount mints a 24-word mnemonic; revealMnemonic round-trips through Bip39", async () => {
  const vault = openVault();
  const created = await vault.createAccount({ profileName: "Ada", password: "vault-pass-12345" });
  const { mnemonic } = await vault.revealMnemonic({ accountId: created.accountId, password: "vault-pass-12345" });
  assert.equal(typeof mnemonic, "string");
  assert.equal(mnemonic.split(" ").length, 24);
  const validated = Bip39.validateMnemonic(mnemonic);
  assert.equal(validated.ok, true);

  // mnemonic → seed → desktop identity must match what's in the vault.
  const seed = await Bip39.mnemonicToSeed(mnemonic);
  const desktopKeys = SeedKeys.deriveEd25519({ seed, label: "rez/identity/desktop-account/v1" });
  const derivedIdentity = Identity.fromObject(desktopKeys);
  assert.equal(derivedIdentity.getAccountId(), created.accountId);
  vault.close();
});

test("revealMnemonic fails with wrong password", async () => {
  const vault = openVault();
  const created = await vault.createAccount({ profileName: "Ada", password: "vault-pass-12345" });
  await assert.rejects(
    () => vault.revealMnemonic({ accountId: created.accountId, password: "nope" }),
    /password|decrypt|integrity|OperationError/i,
  );
  vault.close();
});

test("changePassword re-wraps keystore + appKey + mnemonic under new password and clears device-unlock", async () => {
  const vault = openVault();
  const created = await vault.createAccount({ profileName: "Grace", password: "old-pass-12345" });
  // Capture original mnemonic so we can verify it still decrypts after change.
  const before = await vault.revealMnemonic({ accountId: created.accountId, password: "old-pass-12345" });

  await vault.enableDeviceUnlock({ accountId: created.accountId, password: "old-pass-12345" });
  assert.equal(vault.listAccounts()[0].deviceUnlockEnabled, true);

  await vault.changePassword({
    accountId: created.accountId,
    oldPassword: "old-pass-12345",
    newPassword: "new-pass-67890",
  });
  // Vault must be auto-locked after change.
  assert.equal(vault.status().locked, true);
  // Device unlock must be cleared so user re-enables under new password explicitly.
  assert.equal(vault.listAccounts()[0].deviceUnlockEnabled, false);

  await assert.rejects(
    () => vault.unlock({ accountId: created.accountId, password: "old-pass-12345" }),
    /password|decrypt|integrity|OperationError/i,
  );
  const unlocked = await vault.unlock({ accountId: created.accountId, password: "new-pass-67890" });
  assert.equal(unlocked.accountId, created.accountId);

  // Mnemonic must still decrypt under the new password and be the same one.
  const after = await vault.revealMnemonic({ accountId: created.accountId, password: "new-pass-67890" });
  assert.equal(after.mnemonic, before.mnemonic);
  vault.close();
});

test("changePassword refuses wrong old password and refuses identical old==new", async () => {
  const vault = openVault();
  const created = await vault.createAccount({ profileName: "Ada", password: "vault-pass-12345" });
  await assert.rejects(
    () => vault.changePassword({ accountId: created.accountId, oldPassword: "wrong", newPassword: "new-pass-67890" }),
    /password|decrypt|integrity|OperationError/i,
  );
  await assert.rejects(
    () => vault.changePassword({ accountId: created.accountId, oldPassword: "vault-pass-12345", newPassword: "vault-pass-12345" }),
    /matches old password/i,
  );
  vault.close();
});

test("resetPasswordWithMnemonic recovers a locked-out account with the correct phrase", async () => {
  const vault = openVault();
  const created = await vault.createAccount({ profileName: "Forgetful", password: "old-pass-12345" });
  const { mnemonic } = await vault.revealMnemonic({ accountId: created.accountId, password: "old-pass-12345" });

  // Forget the password — vault is locked, only the mnemonic is in hand.
  vault.lock();

  await vault.resetPasswordWithMnemonic({
    accountId: created.accountId,
    mnemonic,
    newPassword: "new-pass-67890",
  });

  // Old password no longer unlocks.
  await assert.rejects(
    () => vault.unlock({ accountId: created.accountId, password: "old-pass-12345" }),
    /password|decrypt|integrity|OperationError/i,
  );
  // New password does.
  const unlocked = await vault.unlock({ accountId: created.accountId, password: "new-pass-67890" });
  assert.equal(unlocked.accountId, created.accountId);
  // Mnemonic still recoverable + unchanged.
  const after = await vault.revealMnemonic({ accountId: created.accountId, password: "new-pass-67890" });
  assert.equal(after.mnemonic, mnemonic);
  vault.close();
});

test("resetPasswordWithMnemonic refuses a tampered phrase", async () => {
  const vault = openVault();
  const created = await vault.createAccount({ profileName: "Forgetful", password: "old-pass-12345" });
  const { mnemonic } = await vault.revealMnemonic({ accountId: created.accountId, password: "old-pass-12345" });

  // Swap word #5 with another valid wordlist word — breaks the BIP39 checksum.
  const words = mnemonic.split(" ");
  words[4] = words[4] === "abandon" ? "ability" : "abandon";
  const tampered = words.join(" ");

  await assert.rejects(
    () => vault.resetPasswordWithMnemonic({
      accountId: created.accountId,
      mnemonic: tampered,
      newPassword: "new-pass-67890",
    }),
    /recovery phrase|fingerprint|derives|checksum/i,
  );
  vault.close();
});

test("getChatServerIdentity surfaces the BIP39-derived chat-server identity after unlock", async () => {
  const vault = openVault();
  const created = await vault.createAccount({ profileName: "Ada", password: "vault-pass-12345" });
  const ident = vault.getChatServerIdentity();
  assert.ok(ident, "getChatServerIdentity should be non-null after createAccount");
  assert.match(ident.accountId, /^rez:acct:/);
  assert.notEqual(ident.accountId, created.accountId, "chat-server identity must be distinct from desktop identity");

  // Lock + unlock — chat-server identity must be re-derived (not lost) from the mnemonic in the vault row.
  vault.lock();
  assert.equal(vault.getChatServerIdentity(), null);
  await vault.unlock({ accountId: created.accountId, password: "vault-pass-12345" });
  const ident2 = vault.getChatServerIdentity();
  assert.equal(ident2.accountId, ident.accountId);
  assert.equal(ident2.publicKeyB64, ident.publicKeyB64);
  assert.equal(ident2.privateKeyB64, ident.privateKeyB64);
  vault.close();
});

test("purgeAccount deletes the vault row after password check", async () => {
  const vault = openVault();
  const created = await vault.createAccount({ profileName: "Doomed", password: "vault-pass-12345" });
  assert.equal(vault.listAccounts().length, 1);
  await assert.rejects(
    () => vault.purgeAccount({ accountId: created.accountId, password: "wrong" }),
    /password|decrypt|integrity|OperationError/i,
  );
  assert.equal(vault.listAccounts().length, 1);
  const result = await vault.purgeAccount({ accountId: created.accountId, password: "vault-pass-12345" });
  assert.equal(result.purged, true);
  assert.equal(vault.listAccounts().length, 0);
  // Vault is also locked.
  assert.equal(vault.status().locked, true);
  vault.close();
});

test("createAccount with a caller-supplied mnemonic round-trips identity", async () => {
  // Use a known mnemonic so we can predict the identity it should yield.
  const mnemonic = Bip39.entropyToMnemonic(Buffer.alloc(32, 0xaa));
  const seed = await Bip39.mnemonicToSeed(mnemonic);
  const desktopKeys = SeedKeys.deriveEd25519({ seed, label: "rez/identity/desktop-account/v1" });
  const expectedAccountId = Identity.fromObject(desktopKeys).getAccountId();

  const vault = openVault();
  const created = await vault.createAccount({
    profileName: "Restored",
    password: "vault-pass-12345",
    mnemonic,
  });
  assert.equal(created.accountId, expectedAccountId);
  const { mnemonic: revealed } = await vault.revealMnemonic({
    accountId: created.accountId,
    password: "vault-pass-12345",
  });
  assert.equal(revealed, mnemonic);
  vault.close();
});

// Phase 5 — encrypted backup export/import.

test("exportBackup → importBackup roundtrip recovers the random app-data key on a fresh vault", async () => {
  const src = openVault();
  const created = await src.createAccount({ profileName: "Restorable", password: "src-pass-12345" });
  const keyBefore = Buffer.from(src.getAppDataKeyBytes()).toString("base64");
  const { mnemonic } = await src.revealMnemonic({ accountId: created.accountId, password: "src-pass-12345" });
  const envelope = await src.exportBackup({ accountId: created.accountId, password: "src-pass-12345" });
  assert.equal(envelope.type, "rez-backup");
  assert.equal(envelope.v, 1);
  assert.equal(envelope.accountId, created.accountId);
  // The mnemonic and the raw app-data key must NOT appear in the envelope.
  const envJson = JSON.stringify(envelope);
  assert.equal(envJson.includes(mnemonic.split(" ")[0] + " "), false);
  assert.equal(Object.prototype.hasOwnProperty.call(envelope, "appDataKeyB64"), false);
  src.close();

  // Fresh device: a brand-new vault DB. Import under a NEW password.
  const dst = openVault();
  const restored = await dst.importBackup({ encryptedBackup: envelope, mnemonic, newPassword: "dst-pass-67890" });
  assert.equal(restored.accountId, created.accountId);
  const keyAfter = Buffer.from(dst.getAppDataKeyBytes()).toString("base64");
  assert.equal(keyAfter, keyBefore, "recovered app-data key must match the original random key");

  // New password unlocks; identity + mnemonic preserved.
  dst.lock();
  await dst.unlock({ accountId: created.accountId, password: "dst-pass-67890" });
  const after = await dst.revealMnemonic({ accountId: created.accountId, password: "dst-pass-67890" });
  assert.equal(after.mnemonic, mnemonic);
  dst.close();
});

test("importBackup rejects a wrong recovery phrase", async () => {
  const src = openVault();
  const created = await src.createAccount({ profileName: "Restorable", password: "src-pass-12345" });
  const envelope = await src.exportBackup({ accountId: created.accountId, password: "src-pass-12345" });
  src.close();

  const wrongMnemonic = Bip39.generateMnemonic({ words: 24 });
  const dst = openVault();
  await assert.rejects(
    () => dst.importBackup({ encryptedBackup: envelope, mnemonic: wrongMnemonic, newPassword: "dst-pass-67890" }),
    /recovery phrase does not match|decryption failed/i,
  );
  dst.close();
});

test("importBackup refuses to clobber an account that already exists", async () => {
  const src = openVault();
  const created = await src.createAccount({ profileName: "Restorable", password: "src-pass-12345" });
  const { mnemonic } = await src.revealMnemonic({ accountId: created.accountId, password: "src-pass-12345" });
  const envelope = await src.exportBackup({ accountId: created.accountId, password: "src-pass-12345" });
  // Same vault still holds the account → import must refuse.
  await assert.rejects(
    () => src.importBackup({ encryptedBackup: envelope, mnemonic, newPassword: "dst-pass-67890" }),
    /already exists/i,
  );
  src.close();
});

test("importBackup rejects a tampered ciphertext", async () => {
  const src = openVault();
  const created = await src.createAccount({ profileName: "Restorable", password: "src-pass-12345" });
  const { mnemonic } = await src.revealMnemonic({ accountId: created.accountId, password: "src-pass-12345" });
  const envelope = await src.exportBackup({ accountId: created.accountId, password: "src-pass-12345" });
  src.close();

  // Flip the last base64 char of the ciphertext (still valid base64, bad tag).
  const last = envelope.ciphertextB64.slice(-1);
  const swapped = last === "A" ? "B" : "A";
  const tampered = { ...envelope, ciphertextB64: envelope.ciphertextB64.slice(0, -1) + swapped };

  const dst = openVault();
  await assert.rejects(
    () => dst.importBackup({ encryptedBackup: tampered, mnemonic, newPassword: "dst-pass-67890" }),
    /decryption failed/i,
  );
  dst.close();
});

// ---- Phase 6 — pre-BIP39 migration gate -----------------------------------

// Build a vault on an injected better-sqlite3 instance so the test can reach
// in and NULL the recovery columns, simulating an account created before BIP39.
function openVaultWithDb() {
  const db = new Database(tmpPath("vault.sqlite"));
  const vault = new DesktopVaultService({ database: db, safeStorage: createSafeStorage() }).open();
  return { vault, db };
}

test("listAccounts reports recoveryEnabled true for a BIP39 account", async () => {
  const vault = openVault();
  await vault.createAccount({ profileName: "Modern", password: "vault-pass-12345" });
  const entry = vault.listAccounts()[0];
  assert.equal(entry.recoveryEnabled, true);
  vault.close();
});

test("listAccounts reports recoveryEnabled false for a pre-BIP39 row", async () => {
  const { vault, db } = openVaultWithDb();
  const created = await vault.createAccount({ profileName: "Legacy", password: "vault-pass-12345" });
  // Simulate a pre-BIP39 account: no mnemonic envelope, no seed fingerprint.
  db.prepare("UPDATE vault_accounts SET mnemonicEnvelopeJson = NULL, seedFingerprintB64 = NULL WHERE accountId = ?")
    .run(created.accountId);
  const entry = vault.listAccounts()[0];
  assert.equal(entry.recoveryEnabled, false);
  vault.close();
});

test("purgeAccount removes a LOCKED pre-BIP39 row by explicit accountId with the correct password", async () => {
  const { vault, db } = openVaultWithDb();
  const created = await vault.createAccount({ profileName: "Legacy", password: "vault-pass-12345" });
  db.prepare("UPDATE vault_accounts SET mnemonicEnvelopeJson = NULL, seedFingerprintB64 = NULL WHERE accountId = ?")
    .run(created.accountId);
  // The migration purges without first unlocking — the account is locked.
  vault.lock();
  const res = await vault.purgeAccount({ accountId: created.accountId, password: "vault-pass-12345" });
  assert.equal(res.purged, true);
  assert.equal(vault.listAccounts().length, 0);
  vault.close();
});

test("purgeAccount refuses a pre-BIP39 row with the wrong password", async () => {
  const { vault, db } = openVaultWithDb();
  const created = await vault.createAccount({ profileName: "Legacy", password: "vault-pass-12345" });
  db.prepare("UPDATE vault_accounts SET mnemonicEnvelopeJson = NULL, seedFingerprintB64 = NULL WHERE accountId = ?")
    .run(created.accountId);
  vault.lock();
  await assert.rejects(
    () => vault.purgeAccount({ accountId: created.accountId, password: "wrong-pass-99999" }),
    /password|decrypt|integrity|OperationError/i,
  );
  // Row must survive a failed purge.
  assert.equal(vault.listAccounts().length, 1);
  vault.close();
});

// ---- Audit follow-ups — adversarial edge cases ----------------------------
// These assert invariants the code enforces but that no test previously pinned,
// so a regression in any one of them would otherwise pass CI silently.

test("importBackup rejects a backup whose AAD-bound header (accountId) was tampered", async () => {
  const src = openVault();
  const created = await src.createAccount({ profileName: "Restorable", password: "src-pass-12345" });
  const { mnemonic } = await src.revealMnemonic({ accountId: created.accountId, password: "src-pass-12345" });
  const envelope = await src.exportBackup({ accountId: created.accountId, password: "src-pass-12345" });
  src.close();

  // Flip the last char of accountId. It stays a non-empty string (passes shape
  // validation) and seedFingerprintB64 is untouched (passes the cheap
  // pre-check), so the ONLY guard that can reject this is the AES-GCM AAD,
  // which binds accountId into the authenticated header. If AAD binding were
  // dropped, decrypt would succeed and the later identity check would throw a
  // DIFFERENT error ("derives a different identity"). Asserting the crypto-layer
  // "decryption failed" message proves the AAD itself caught it.
  const lastChar = envelope.accountId.slice(-1);
  const tamperedId = envelope.accountId.slice(0, -1) + (lastChar === "a" ? "b" : "a");
  const tampered = { ...envelope, accountId: tamperedId };

  const dst = openVault();
  await assert.rejects(
    () => dst.importBackup({ encryptedBackup: tampered, mnemonic, newPassword: "dst-pass-67890" }),
    /decryption failed/i,
  );
  dst.close();
});

test("importBackup rejects a structurally invalid mnemonic before any crypto runs", async () => {
  const src = openVault();
  const created = await src.createAccount({ profileName: "Restorable", password: "src-pass-12345" });
  const envelope = await src.exportBackup({ accountId: created.accountId, password: "src-pass-12345" });
  src.close();

  const dst = openVault();
  await assert.rejects(
    () => dst.importBackup({
      encryptedBackup: envelope,
      mnemonic: "not a real bip39 phrase obviously",
      newPassword: "dst-pass-67890",
    }),
    /invalid recovery phrase/i,
  );
  dst.close();
});

test("resetPasswordWithMnemonic hard-fails when the OS-wrapped app key is absent", async () => {
  const { vault, db } = openVaultWithDb();
  const created = await vault.createAccount({ profileName: "NoKeychain", password: "old-pass-12345" });
  const { mnemonic } = await vault.revealMnemonic({ accountId: created.accountId, password: "old-pass-12345" });
  // Simulate a device where the OS keychain never wrapped the app key. Without
  // it the random app-data key can't be recovered from the mnemonic alone, so
  // reset must refuse rather than silently strand the app data (the docstring's
  // documented hard-fail). Backup-restore is the alternative recovery path.
  db.prepare("UPDATE vault_accounts SET safeWrappedAppKeyB64 = NULL WHERE accountId = ?").run(created.accountId);
  vault.lock();
  await assert.rejects(
    () => vault.resetPasswordWithMnemonic({ accountId: created.accountId, mnemonic, newPassword: "new-pass-67890" }),
    /OS-wrapped app data key/i,
  );
  vault.close();
});

test("unlock detects an OS-wrapped app key that disagrees with the password-wrapped key", async () => {
  const { vault, db } = openVaultWithDb();
  const created = await vault.createAccount({ profileName: "Tampered", password: "vault-pass-12345" });
  // Overwrite the OS-wrapped app key with a wrap of a DIFFERENT key. The fake
  // safeStorage prefixes "wrapped:"; bufferToBase64/base64ToBuffer are standard
  // base64, so we can reproduce the on-disk shape exactly. unlock's
  // #verifySafeWrappedAppDataKey must catch the disagreement.
  const wrongKeyB64 = Buffer.alloc(32, 0x07).toString("base64");
  const corruptWrap = Buffer.from("wrapped:" + wrongKeyB64, "utf8").toString("base64");
  db.prepare("UPDATE vault_accounts SET safeWrappedAppKeyB64 = ? WHERE accountId = ?").run(corruptWrap, created.accountId);
  vault.lock();
  await assert.rejects(
    () => vault.unlock({ accountId: created.accountId, password: "vault-pass-12345" }),
    /OS wrapped vault key mismatch/i,
  );
  vault.close();
});

test("changePassword works on a pre-BIP39 row (no mnemonic) and keeps it recovery-disabled", async () => {
  const { vault, db } = openVaultWithDb();
  const created = await vault.createAccount({ profileName: "Legacy", password: "old-pass-12345" });
  db.prepare("UPDATE vault_accounts SET mnemonicEnvelopeJson = NULL, seedFingerprintB64 = NULL WHERE accountId = ?")
    .run(created.accountId);
  assert.equal(vault.listAccounts()[0].recoveryEnabled, false);

  await vault.changePassword({
    accountId: created.accountId,
    oldPassword: "old-pass-12345",
    newPassword: "new-pass-67890",
  });
  assert.equal(vault.status().locked, true);
  await assert.rejects(
    () => vault.unlock({ accountId: created.accountId, password: "old-pass-12345" }),
    /password|decrypt|integrity|OperationError/i,
  );
  const unlocked = await vault.unlock({ accountId: created.accountId, password: "new-pass-67890" });
  assert.equal(unlocked.accountId, created.accountId);
  // The password change must not conjure a recovery phrase for a legacy row.
  assert.equal(vault.listAccounts()[0].recoveryEnabled, false);
  vault.close();
});
