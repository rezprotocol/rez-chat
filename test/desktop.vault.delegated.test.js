// S2.5 S9 K4 — DesktopVaultService delegated (seedless) rows on keystore v3.
//
// createDelegatedAccount consumes a hand-built delegation bundle (real B root
// + device key C minted BEFORE the cert + single-hop capability chain + real
// X25519 account DH key — exactly what the S10 ceremony will deliver), seals
// a v3 keystore, and stores a row with NO mnemonic and NO seed fingerprint.
// Unlock rebuilds the delegated chat-server identity contract straight from
// the keystore payload; every mnemonic-rooted method fails loud with a
// delegated-specific message. Direct rows are untouched (regression pinned by
// the existing desktop.vault suites).

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  bytesToBase64,
  deriveAccountIdFromPublicKey,
  DeviceRegistrationV1,
  AccountDeviceCapabilityV1,
  ACCOUNT_DEVICE_CAPABILITY_PURPOSE,
} from "@rezprotocol/core";
import { NodeCryptoProvider } from "@rezprotocol/node";
import { DesktopVaultService } from "../electron/runtime/DesktopVaultService.mjs";

const CRYPTO = new NodeCryptoProvider();
const NOW = Date.now();
const FAR = NOW + 7 * 24 * 60 * 60 * 1000;
const PASSWORD = "correct horse battery staple";

function tmpPath(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rez-desktop-vault-del-"));
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

function buildLeafCert({ accountPubB64, accountPrivBytes, granteePubB64, capabilities }) {
  const fields = {
    v: 1,
    purpose: ACCOUNT_DEVICE_CAPABILITY_PURPOSE,
    accountIdentityPublicKeyB64: accountPubB64,
    parentCertId: null,
    granteeDevicePublicKeyB64: granteePubB64,
    granteeDeviceId: DeviceRegistrationV1.deviceIdFor(granteePubB64),
    capabilities,
    maxDelegationDepth: 0,
    issuedAtMs: NOW - 1000,
    expiresAtMs: FAR,
    signerPublicKeyB64: accountPubB64,
  };
  const certId = AccountDeviceCapabilityV1.deriveCertId(fields);
  const sigBytes = CRYPTO.sign({ privateKey: accountPrivBytes, msg: AccountDeviceCapabilityV1.signableBytes({ ...fields, certId }) });
  return new AccountDeviceCapabilityV1({ ...fields, certId, sig: { alg: "ed25519", sigB64: bytesToBase64(sigBytes) } });
}

// The ceremony order: the new device mints C FIRST, the primary certs it,
// then the bundle (chain + B public material + B-dh) arrives.
function makeDelegationInputs() {
  const b = CRYPTO.generateSigningKeyPair();
  const c = CRYPTO.generateSigningKeyPair();
  const dh = CRYPTO.dhGenerateKeyPair();
  const accountPubB64 = bytesToBase64(b.publicKey);
  const deviceKeyPair = { publicKeyB64: bytesToBase64(c.publicKey), privateKeyB64: bytesToBase64(c.privateKey) };
  const leafCert = buildLeafCert({
    accountPubB64,
    accountPrivBytes: b.privateKey,
    granteePubB64: deviceKeyPair.publicKeyB64,
    capabilities: ["peerLink.create", "deviceSet.publish"],
  });
  b.privateKey.fill(0);
  return {
    accountId: deriveAccountIdFromPublicKey(b.publicKey),
    accountPubB64,
    deviceKeyPair,
    delegationBundle: {
      accountSignPublicKeyB64: accountPubB64,
      accountDhKeyPair: {
        publicKeyB64: bytesToBase64(dh.publicKey),
        privateKeyB64: bytesToBase64(dh.privateKey),
      },
      certChain: [leafCert.toJSON()],
      cachedDeviceSet: null,
    },
  };
}

function openVault() {
  return new DesktopVaultService({
    dbPath: tmpPath("vault.sqlite"),
    safeStorage: createSafeStorage(),
  }).open();
}

test("createDelegatedAccount → unlock: v3 row, delegated identity contract, C round-trips", async () => {
  const vault = openVault();
  const d = makeDelegationInputs();

  const summary = await vault.createDelegatedAccount({
    profileName: "Phone",
    password: PASSWORD,
    deviceKeyPair: d.deviceKeyPair,
    delegationBundle: d.delegationBundle,
  });
  assert.equal(summary.accountId, d.accountId, "the vault row keys on the ACCOUNT (B) id");
  assert.equal(vault.status().locked, false);

  const ident = vault.getChatServerIdentity();
  assert.equal(ident.accountId, d.accountId);
  assert.equal(ident.publicKeyB64, d.accountPubB64);
  assert.equal(ident.privateKeyB64, null, "a delegated identity carries NO account private key");
  assert.equal(ident.hasAdminRoot, false);
  assert.equal(Array.isArray(ident.certChain) && ident.certChain.length, 1);
  assert.deepEqual(ident.accountIdentityDhKeyPair, d.delegationBundle.accountDhKeyPair);

  const deviceKey = vault.getActiveDeviceKey();
  assert.equal(deviceKey.deviceId, DeviceRegistrationV1.deviceIdFor(d.deviceKeyPair.publicKeyB64));
  assert.deepEqual(deviceKey.deviceKeyPair, d.deviceKeyPair, "C is accepted, never re-minted");

  // The app-data key machinery is identical to a primary account.
  assert.equal(vault.getAppDataKeyBytes().length, 32);

  // Relock → re-unlock rebuilds the identity from the keystore alone.
  vault.lock();
  assert.equal(vault.status().locked, true);
  await vault.unlock({ accountId: d.accountId, password: PASSWORD });
  const again = vault.getChatServerIdentity();
  assert.equal(again.hasAdminRoot, false);
  assert.equal(again.privateKeyB64, null);
  assert.deepEqual(again.certChain, ident.certChain);
  assert.deepEqual(vault.getActiveDeviceKey().deviceKeyPair, d.deviceKeyPair);
  vault.close();
});

test("listAccounts marks the row delegated with recovery deliberately off", async () => {
  const vault = openVault();
  const d = makeDelegationInputs();
  await vault.createDelegatedAccount({
    profileName: "Phone",
    password: PASSWORD,
    deviceKeyPair: d.deviceKeyPair,
    delegationBundle: d.delegationBundle,
  });
  const rows = vault.listAccounts();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].delegated, true);
  assert.equal(rows[0].recoveryEnabled, false, "no mnemonic exists on a delegated device");
  vault.close();
});

test("mnemonic-rooted methods fail loud with the delegated message (recovery lives on the primary)", async () => {
  const vault = openVault();
  const d = makeDelegationInputs();
  await vault.createDelegatedAccount({
    profileName: "Phone",
    password: PASSWORD,
    deviceKeyPair: d.deviceKeyPair,
    delegationBundle: d.delegationBundle,
  });
  const accountId = d.accountId;
  await assert.rejects(
    () => vault.revealMnemonic({ accountId, password: PASSWORD }),
    /delegated device — the recovery phrase and backup live on the primary device/,
  );
  await assert.rejects(
    () => vault.exportBackup({ accountId, password: PASSWORD }),
    /delegated device — the recovery phrase and backup live on the primary device/,
  );
  await assert.rejects(
    () => vault.resetPasswordWithMnemonic({ accountId, mnemonic: "abandon ".repeat(23) + "art", newPassword: "another strong pw" }),
    /delegated device — the recovery phrase and backup live on the primary device/,
  );
  vault.close();
});

test("S10 changePassword on a delegated row: payload-preserving re-seal, identical identity under the new password", async () => {
  const vault = openVault();
  const d = makeDelegationInputs();
  await vault.createDelegatedAccount({
    profileName: "Phone",
    password: PASSWORD,
    deviceKeyPair: d.deviceKeyPair,
    delegationBundle: d.delegationBundle,
  });
  const before = vault.getChatServerIdentity();
  const beforeDevice = vault.getActiveDeviceKey();
  const NEW = "a whole new strong password";
  const result = await vault.changePassword({ accountId: d.accountId, oldPassword: PASSWORD, newPassword: NEW });
  assert.equal(result.accountId, d.accountId);
  assert.equal(vault.status().locked, true, "re-seal auto-locks");

  // The OLD password no longer unlocks; the NEW one does, with a byte-identical
  // delegated identity (chain, B-dh, device key all preserved).
  await assert.rejects(
    () => vault.unlock({ accountId: d.accountId, password: PASSWORD }),
    /decrypt|password|unlock|OperationError|integrity/i,
  );
  await vault.unlock({ accountId: d.accountId, password: NEW });
  const after = vault.getChatServerIdentity();
  assert.equal(after.hasAdminRoot, false);
  assert.equal(after.publicKeyB64, before.publicKeyB64);
  assert.deepEqual(after.certChain, before.certChain);
  assert.deepEqual(after.accountIdentityDhKeyPair, before.accountIdentityDhKeyPair);
  assert.deepEqual(vault.getActiveDeviceKey().deviceKeyPair, beforeDevice.deviceKeyPair);
  vault.close();
});

test("S10 delegated changePassword with the wrong old password does not mutate the row", async () => {
  const vault = openVault();
  const d = makeDelegationInputs();
  await vault.createDelegatedAccount({
    profileName: "Phone",
    password: PASSWORD,
    deviceKeyPair: d.deviceKeyPair,
    delegationBundle: d.delegationBundle,
  });
  await assert.rejects(
    () => vault.changePassword({ accountId: d.accountId, oldPassword: "wrong password", newPassword: "another strong pw" }),
    /decrypt|password|unlock|OperationError|integrity/i,
  );
  // The original password still unlocks — nothing was half-written.
  await vault.unlock({ accountId: d.accountId, password: PASSWORD });
  assert.equal(vault.getChatServerIdentity().hasAdminRoot, false);
  vault.close();
});

test("createDelegatedAccount validates its inputs (missing C / bundle pieces fail loud)", async () => {
  const vault = openVault();
  const d = makeDelegationInputs();
  await assert.rejects(
    () => vault.createDelegatedAccount({ profileName: "P", password: PASSWORD, deviceKeyPair: null, delegationBundle: d.delegationBundle }),
    /requires deviceKeyPair/,
  );
  await assert.rejects(
    () => vault.createDelegatedAccount({ profileName: "P", password: PASSWORD, deviceKeyPair: d.deviceKeyPair, delegationBundle: null }),
    /requires delegationBundle/,
  );
  await assert.rejects(
    () => vault.createDelegatedAccount({
      profileName: "P",
      password: PASSWORD,
      deviceKeyPair: d.deviceKeyPair,
      delegationBundle: { ...d.delegationBundle, certChain: [] },
    }),
    /non-empty delegationBundle\.certChain/,
  );
  // The keystore's structural chain validation reaches through: a chain
  // granted to a DIFFERENT device key than the supplied C is rejected.
  const other = CRYPTO.generateSigningKeyPair();
  await assert.rejects(
    () => vault.createDelegatedAccount({
      profileName: "P",
      password: PASSWORD,
      deviceKeyPair: { publicKeyB64: bytesToBase64(other.publicKey), privateKeyB64: bytesToBase64(other.privateKey) },
      delegationBundle: d.delegationBundle,
    }),
    /leaf grantee does not match the device key/,
  );
  vault.close();
});

test("a delegated row coexists with a primary row; the primary keeps full recovery", async () => {
  const vault = openVault();
  const primary = await vault.createAccount({ profileName: "Desk", password: PASSWORD });
  vault.lock();
  const d = makeDelegationInputs();
  await vault.createDelegatedAccount({
    profileName: "Phone",
    password: PASSWORD,
    deviceKeyPair: d.deviceKeyPair,
    delegationBundle: d.delegationBundle,
  });
  const rows = vault.listAccounts();
  assert.equal(rows.length, 2);
  const primaryRow = rows.find((r) => r.id === primary.accountId);
  const delegatedRow = rows.find((r) => r.id === d.accountId);
  assert.equal(primaryRow.delegated, false);
  assert.equal(primaryRow.recoveryEnabled, true);
  assert.equal(delegatedRow.delegated, true);
  assert.equal(delegatedRow.recoveryEnabled, false);

  // The primary unlocks with a full admin-root identity as before.
  await vault.unlock({ accountId: primary.accountId, password: PASSWORD });
  const ident = vault.getChatServerIdentity();
  assert.equal(ident.hasAdminRoot, true);
  assert.equal(typeof ident.privateKeyB64, "string");
  assert.ok(ident.privateKeyB64.length > 0);
  assert.equal("certChain" in ident, false, "a primary identity gains NO chain field");
  vault.close();
});
