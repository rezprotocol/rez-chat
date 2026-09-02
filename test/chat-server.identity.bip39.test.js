// Phase 2 — ensureChatServerIdentity with BIP39-seed-rooted expectedIdentity.
//
// Verifies the four behaviors:
//   1. empty storage + no expected → random-generate (legacy path)
//   2. empty storage + expected → persist expected as-is
//   3. stored + expected matches → return stored (no-op)
//   4. stored + expected differs + !allowOverwrite → throw
//   5. stored + expected differs + allowOverwrite → overwrite + return new
//   6. stored + no expected → return stored (legacy: boot-before-vault-unlock path)

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { FsStorageProvider, NodeCryptoProvider } from "@rezprotocol/node";
import { Identity } from "@rezprotocol/sdk/client";
import { Bip39 } from "@rezprotocol/sdk/crypto/bip39";
import { SeedKeys } from "@rezprotocol/sdk/crypto/seedDerivation";
import { ensureChatServerIdentity } from "../src/server/identity/ChatServerIdentity.js";

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function deriveSeededIdentity() {
  const mnemonic = Bip39.entropyToMnemonic(Buffer.alloc(32, 0x11));
  const seed = await Bip39.mnemonicToSeed(mnemonic);
  const keys = SeedKeys.deriveEd25519({ seed, label: "rez/identity/chat-server/v1" });
  const identity = Identity.fromObject(keys);
  return {
    accountId: identity.getAccountId(),
    publicKeyB64: keys.publicKeyB64,
    privateKeyB64: keys.privateKeyB64,
  };
}

test("ensureChatServerIdentity — empty storage + expectedIdentity → persists expected", async () => {
  const rootDir = tmpDir("rez-csi-1-");
  const cryptoProvider = new NodeCryptoProvider();
  const expected = await deriveSeededIdentity();

  const first = await ensureChatServerIdentity({
    storageProvider: new FsStorageProvider({ rootDir }),
    cryptoProvider,
    expectedIdentity: expected,
  });
  assert.equal(first.accountId, expected.accountId);
  assert.equal(first.publicKeyB64, expected.publicKeyB64);
  assert.equal(first.privateKeyB64, expected.privateKeyB64);
  // deviceId is freshly minted, not part of expected.
  assert.match(first.deviceId, /^dev:/);

  // Subsequent call with same expected returns the same stored record.
  const second = await ensureChatServerIdentity({
    storageProvider: new FsStorageProvider({ rootDir }),
    cryptoProvider,
    expectedIdentity: expected,
  });
  assert.equal(second.publicKeyB64, first.publicKeyB64);
  assert.equal(second.deviceId, first.deviceId, "deviceId must be stable across reads");
});

test("ensureChatServerIdentity — stored + expected mismatch throws unless allowOverwrite", async () => {
  const rootDir = tmpDir("rez-csi-2-");
  const cryptoProvider = new NodeCryptoProvider();
  const expectedA = await deriveSeededIdentity();
  const mnemonicB = Bip39.entropyToMnemonic(Buffer.alloc(32, 0x22));
  const seedB = await Bip39.mnemonicToSeed(mnemonicB);
  const keysB = SeedKeys.deriveEd25519({ seed: seedB, label: "rez/identity/chat-server/v1" });
  const identityB = Identity.fromObject(keysB);
  const expectedB = { accountId: identityB.getAccountId(), publicKeyB64: keysB.publicKeyB64, privateKeyB64: keysB.privateKeyB64 };

  // Seed storage with A.
  await ensureChatServerIdentity({
    storageProvider: new FsStorageProvider({ rootDir }),
    cryptoProvider,
    expectedIdentity: expectedA,
  });

  // Trying to ensure with B (no rotation) must throw.
  await assert.rejects(
    () => ensureChatServerIdentity({
      storageProvider: new FsStorageProvider({ rootDir }),
      cryptoProvider,
      expectedIdentity: expectedB,
    }),
    /does not match expectedIdentity|allowOverwrite/i,
  );

  // With allowOverwrite=true the rotation succeeds.
  const rotated = await ensureChatServerIdentity({
    storageProvider: new FsStorageProvider({ rootDir }),
    cryptoProvider,
    expectedIdentity: expectedB,
    allowOverwrite: true,
  });
  assert.equal(rotated.accountId, expectedB.accountId);
  assert.equal(rotated.publicKeyB64, expectedB.publicKeyB64);
});

test("ensureChatServerIdentity — legacy empty + no expected still random-generates", async () => {
  const rootDir = tmpDir("rez-csi-3-");
  const cryptoProvider = new NodeCryptoProvider();
  const a = await ensureChatServerIdentity({
    storageProvider: new FsStorageProvider({ rootDir }),
    cryptoProvider,
  });
  assert.match(a.accountId, /^rez:acct:/);
  assert.match(a.deviceId, /^dev:/);
  const b = await ensureChatServerIdentity({
    storageProvider: new FsStorageProvider({ rootDir }),
    cryptoProvider,
  });
  assert.equal(b.publicKeyB64, a.publicKeyB64);
});

// --- GHSA-7gc9-4c96-2rxm: cleartext root key custody ---------------------
//
// The advisory: the desktop primary persisted the account ROOT SIGNING PRIVATE
// KEY in cleartext, and derived the key protecting every other KV value from
// it — one directory read yielded full account authority plus all state.
//
// Ruling (Noah, 2026-08-30): stop writing it, and remove the existing on-disk
// copy only once the key is PROVEN to be where it should be. These tests pin
// both halves, and the refusals that make the scrub safe.

const STORE_KEY = "chat-server:identity:v1";

function fileContainingSecret(dir, secret) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const hit = fileContainingSecret(full, secret);
      if (hit) return hit;
    } else if (entry.isFile() && fs.readFileSync(full, "utf8").includes(secret)) {
      return full;
    }
  }
  return null;
}


async function readStoredRow(rootDir) {
  return new FsStorageProvider({ rootDir }).getKeyValueStore(null).get(STORE_KEY);
}

test("GHSA-7gc9: a fresh install never writes the root private key to disk", async () => {
  const rootDir = tmpDir("rez-csi-ghsa-fresh-");
  const expected = await deriveSeededIdentity();

  const runtime = await ensureChatServerIdentity({
    storageProvider: new FsStorageProvider({ rootDir }),
    cryptoProvider: new NodeCryptoProvider(),
    expectedIdentity: expected,
  });

  const row = await readStoredRow(rootDir);
  assert.equal(row.privateKeyB64, "", "the persisted row must not carry the root private key");
  assert.equal(row.rootKeyCustody, "vault", "the row must declare the vault as the key's home");
  assert.equal(runtime.privateKeyB64, expected.privateKeyB64,
    "the RUNTIME identity still holds the key — it just no longer comes off disk");

  // The strongest form of the assertion: the key appears in NO file the
  // chat-server wrote. This is the check that would have caught the advisory.
  assert.equal(fileContainingSecret(rootDir, expected.privateKeyB64), null,
    "the private key must not appear in any file under the storage root");
});

test("GHSA-7gc9: an upgraded boot SCRUBS a legacy cleartext row — but only once the vault proves it holds the same key", async () => {
  const rootDir = tmpDir("rez-csi-ghsa-scrub-");
  const expected = await deriveSeededIdentity();

  // Seed a pre-advisory row exactly as the vulnerable build wrote it.
  const kv = new FsStorageProvider({ rootDir }).getKeyValueStore(null);
  await kv.set(STORE_KEY, {
    accountId: expected.accountId,
    deviceId: "dev:legacyfixture",
    publicKeyB64: expected.publicKeyB64,
    privateKeyB64: expected.privateKeyB64,
  });
  assert.equal((await readStoredRow(rootDir)).privateKeyB64, expected.privateKeyB64,
    "fixture precondition: the cleartext key IS on disk");

  const runtime = await ensureChatServerIdentity({
    storageProvider: new FsStorageProvider({ rootDir }),
    cryptoProvider: new NodeCryptoProvider(),
    expectedIdentity: expected,
  });

  const row = await readStoredRow(rootDir);
  assert.equal(row.privateKeyB64, "", "the cleartext key is gone from disk");
  assert.equal(row.rootKeyCustody, "vault");
  assert.equal(row.deviceId, "dev:legacyfixture", "deviceId must survive the scrub");
  assert.equal(runtime.privateKeyB64, expected.privateKeyB64, "the account still boots");
});

test("GHSA-7gc9: same public key but a DIFFERENT private key refuses to scrub — key confusion is not an upgrade", async () => {
  const rootDir = tmpDir("rez-csi-ghsa-confusion-");
  const expected = await deriveSeededIdentity();
  const other = await Identity.generate({ cryptoProvider: new NodeCryptoProvider() });

  const kv = new FsStorageProvider({ rootDir }).getKeyValueStore(null);
  await kv.set(STORE_KEY, {
    accountId: expected.accountId,
    deviceId: "dev:confused",
    publicKeyB64: expected.publicKeyB64,
    privateKeyB64: Buffer.from(other.getPrivateKeyBytes()).toString("base64"),
  });

  await assert.rejects(
    () => ensureChatServerIdentity({
      storageProvider: new FsStorageProvider({ rootDir }),
      cryptoProvider: new NodeCryptoProvider(),
      expectedIdentity: expected,
    }),
    /ROOT_KEY_MISMATCH_SAME_PUBKEY|DIFFERENT private key/,
  );

  const row = await readStoredRow(rootDir);
  assert.notEqual(row.privateKeyB64, "", "nothing was scrubbed — we do not destroy a key we cannot account for");
});

test("GHSA-7gc9: a scrubbed row with no vault identity FAILS LOUD instead of minting a replacement account", async () => {
  const rootDir = tmpDir("rez-csi-ghsa-noexpected-");
  const expected = await deriveSeededIdentity();

  await ensureChatServerIdentity({
    storageProvider: new FsStorageProvider({ rootDir }),
    cryptoProvider: new NodeCryptoProvider(),
    expectedIdentity: expected,
  });

  // Boot again with the vault absent. The pre-fix code would have fallen
  // through and generated a SECOND account, silently orphaning this one.
  await assert.rejects(
    () => ensureChatServerIdentity({
      storageProvider: new FsStorageProvider({ rootDir }),
      cryptoProvider: new NodeCryptoProvider(),
    }),
    /ROOT_KEY_IN_VAULT_BUT_NOT_SUPPLIED|required to boot/,
  );

  const row = await readStoredRow(rootDir);
  assert.equal(row.accountId, expected.accountId, "the original account row is untouched");
});
