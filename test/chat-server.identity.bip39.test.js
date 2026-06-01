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
