// S2.5 S9 K3 — ensureChatServerIdentity with a DELEGATED (seedless) identity.
//
// A delegated device persists the account PUBLIC key + the self-certifying
// deviceId of its device key C — never an account private key. Verifies:
//   1. empty storage + delegated expected → persists the delegated row
//   2. reload with the same expected → returns the stored row
//   3. a delegated expected that CARRIES a private key → throw (contradiction)
//   4. a delegated expected without deviceId → throw
//   5. a priv-less stored blob WITHOUT hasAdminRoot:false still throws
//      (the direct validation is not weakened by the conditional)
//   6. legacy blobs (no hasAdminRoot field) stay admin-root rows

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { FsStorageProvider, NodeCryptoProvider } from "@rezprotocol/node";
import { Identity, bytesToBase64, deriveAccountIdFromPublicKey } from "@rezprotocol/sdk/client";
import { ensureChatServerIdentity } from "../src/server/identity/ChatServerIdentity.js";
import { StoredServerIdentity } from "../src/records/domain/StoredServerIdentity.js";

const CRYPTO = new NodeCryptoProvider();

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeDelegatedExpected() {
  const b = CRYPTO.generateSigningKeyPair();
  const c = CRYPTO.generateSigningKeyPair();
  const devicePubB64 = bytesToBase64(c.publicKey);
  return {
    accountId: deriveAccountIdFromPublicKey(b.publicKey),
    publicKeyB64: bytesToBase64(b.publicKey),
    privateKeyB64: null,
    hasAdminRoot: false,
    deviceId: "rez:dev:" + "a".repeat(64),
    devicePubB64,
  };
}

test("delegated expected → persists a no-priv row keyed to the supplied deviceId; reload returns it", async () => {
  const rootDir = tmpDir("rez-csi-del-1-");
  const expected = makeDelegatedExpected();

  const first = await ensureChatServerIdentity({
    storageProvider: new FsStorageProvider({ rootDir }),
    cryptoProvider: CRYPTO,
    expectedIdentity: expected,
  });
  assert.equal(first.accountId, expected.accountId);
  assert.equal(first.publicKeyB64, expected.publicKeyB64);
  assert.equal(first.privateKeyB64, "", "a delegated row stores NO account private key");
  assert.equal(first.hasAdminRoot, false);
  assert.equal(first.deviceId, expected.deviceId, "the self-certifying device id is persisted, not a random dev: id");

  const second = await ensureChatServerIdentity({
    storageProvider: new FsStorageProvider({ rootDir }),
    cryptoProvider: CRYPTO,
    expectedIdentity: expected,
  });
  assert.equal(second.publicKeyB64, first.publicKeyB64);
  assert.equal(second.hasAdminRoot, false);
  assert.equal(second.deviceId, first.deviceId);
});

test("a delegated expected that carries a private key is a contradiction — throws", async () => {
  const rootDir = tmpDir("rez-csi-del-2-");
  const expected = makeDelegatedExpected();
  const b = CRYPTO.generateSigningKeyPair();
  await assert.rejects(
    () => ensureChatServerIdentity({
      storageProvider: new FsStorageProvider({ rootDir }),
      cryptoProvider: CRYPTO,
      expectedIdentity: { ...expected, privateKeyB64: bytesToBase64(b.privateKey) },
    }),
    /a delegated expectedIdentity must not carry privateKeyB64/,
  );
});

test("a delegated expected without a deviceId throws", async () => {
  const rootDir = tmpDir("rez-csi-del-3-");
  const expected = makeDelegatedExpected();
  await assert.rejects(
    () => ensureChatServerIdentity({
      storageProvider: new FsStorageProvider({ rootDir }),
      cryptoProvider: CRYPTO,
      expectedIdentity: { ...expected, deviceId: "" },
    }),
    /must include accountId, publicKeyB64, deviceId/,
  );
});

test("direct validation is NOT weakened: a priv-less blob without hasAdminRoot:false still throws", async () => {
  const identity = await Identity.generate({ cryptoProvider: CRYPTO });
  assert.throws(
    () => new StoredServerIdentity({
      accountId: identity.getAccountId(),
      deviceId: "dev:abc",
      publicKeyB64: bytesToBase64(identity.getPublicKeyBytes()),
      privateKeyB64: "",
    }),
    /requires privateKeyB64/,
  );
  // And a delegated row that smuggles a priv is rejected at the record layer too.
  assert.throws(
    () => new StoredServerIdentity({
      accountId: identity.getAccountId(),
      deviceId: "dev:abc",
      publicKeyB64: bytesToBase64(identity.getPublicKeyBytes()),
      privateKeyB64: bytesToBase64(identity.getPrivateKeyBytes()),
      hasAdminRoot: false,
    }),
    /delegated row must not carry privateKeyB64/,
  );
});

test("legacy blobs (no hasAdminRoot field) stay admin-root rows", async () => {
  const identity = await Identity.generate({ cryptoProvider: CRYPTO });
  const record = new StoredServerIdentity({
    accountId: identity.getAccountId(),
    deviceId: "dev:legacy",
    publicKeyB64: bytesToBase64(identity.getPublicKeyBytes()),
    privateKeyB64: bytesToBase64(identity.getPrivateKeyBytes()),
  });
  assert.equal(record.hasAdminRoot, true);
  // Round-trips through toJSON with the flag now explicit.
  const back = new StoredServerIdentity(record.toJSON());
  assert.equal(back.hasAdminRoot, true);
});
