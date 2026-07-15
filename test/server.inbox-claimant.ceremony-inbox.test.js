import test from "node:test";
import assert from "node:assert/strict";
import { bytesToBase64 } from "@rezprotocol/core";
import { NodeCryptoProvider } from "@rezprotocol/node";
import { InboxClaimant } from "../src/server/inbox/InboxClaimant.js";

// P1#2 L3.5: a delegated device linked via the device-link ceremony must claim the EXACT
// inbox the ceremony pre-registered (device.add) — persisted in its keystore and passed to
// InboxClaimant.bootstrap as delegatedInboxId — never a freshly-minted one (which would make
// device.add(A) + device.bind(B) collide with ACCOUNT_DEVICE_CONFLICT).

const CRYPTO = new NodeCryptoProvider();
const A = "inbox:" + "a".repeat(24);
const B = "inbox:" + "b".repeat(24);

class MemoryKV {
  #m = new Map();
  async get(k) { return this.#m.has(k) ? this.#m.get(k) : null; }
  async set(k, v) { this.#m.set(k, v); }
  async delete(k) { this.#m.delete(k); }
}
class MemoryStorageProvider {
  #kv;
  constructor(kv) { this.#kv = kv || new MemoryKV(); }
  getKeyValueStore() { return this.#kv; }
}

function deviceIdentity() {
  const kp = CRYPTO.generateSigningKeyPair();
  return { publicKeyB64: bytesToBase64(kp.publicKey), privateKeyB64: bytesToBase64(kp.privateKey) };
}

test("fresh delegated boot claims EXACTLY the ceremony inbox A (not a freshly-minted one)", async () => {
  const storageProvider = new MemoryStorageProvider();
  const claimant = await InboxClaimant.bootstrap({
    storageProvider, cryptoProvider: CRYPTO, identity: deviceIdentity(), delegatedInboxId: A,
  });
  assert.equal(claimant.inboxId, A, "the claimant owns the ceremony inbox");
});

test("restart keeps inbox A (the persisted primary wins; the ceremony inbox agrees)", async () => {
  const storageProvider = new MemoryStorageProvider(); // shared kv across both boots
  const identity = deviceIdentity();
  const first = await InboxClaimant.bootstrap({ storageProvider, cryptoProvider: CRYPTO, identity, delegatedInboxId: A });
  assert.equal(first.inboxId, A);
  const second = await InboxClaimant.bootstrap({ storageProvider, cryptoProvider: CRYPTO, identity, delegatedInboxId: A });
  assert.equal(second.inboxId, A, "a restart reuses the same claimed inbox");
});

test("a keystore ceremony inbox that DIFFERS from the already-persisted primary FAILS LOUD", async () => {
  const storageProvider = new MemoryStorageProvider();
  const identity = deviceIdentity();
  await InboxClaimant.bootstrap({ storageProvider, cryptoProvider: CRYPTO, identity, delegatedInboxId: A });
  // A later boot whose keystore names a DIFFERENT inbox is a hard inconsistency (two
  // identities for one device) — never silently re-mint or overwrite.
  await assert.rejects(
    () => InboxClaimant.bootstrap({ storageProvider, cryptoProvider: CRYPTO, identity, delegatedInboxId: B }),
    /does not match/,
  );
});

test("legacy / primary boot (no ceremony inbox) still mints a fresh canonical inbox (unchanged)", async () => {
  const storageProvider = new MemoryStorageProvider();
  const claimant = await InboxClaimant.bootstrap({
    storageProvider, cryptoProvider: CRYPTO, identity: deviceIdentity(), delegatedInboxId: null,
  });
  assert.match(claimant.inboxId, /^inbox:[0-9a-f]{16,}$/, "a fresh canonical inbox");
  assert.notEqual(claimant.inboxId, A);
});
