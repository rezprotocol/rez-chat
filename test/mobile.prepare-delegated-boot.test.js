// P1.3c (plans/MOBILE_PLATFORM_INTEGRATION_PLAN.md) — prepareDelegatedCoreBoot,
// the unlock → steady-state-boot mapping. What this suite pins:
//
//   - the mapping INTERPRETS durable enrollment truth, read-only: it fails
//     ENROLLMENT_INCOMPLETE when the portable primary is missing (INCLUDING
//     when the claim store holds the bootstrap claim — the exact rejected
//     fallback), and refuses portable == bootstrap;
//   - admin/root authority is rejected before any projection (hasAdminRoot,
//     or an account signing keypair riding along);
//   - the happy path returns EXACTLY the startRezChatCore inputs, with
//     bootstrapInboxId carried as enrollment metadata only;
//   - LEGACY COMPAT: an old envelope sealed with the generic `inboxId` field
//     unlocks as bootstrapInboxId, maps cleanly, and the runtime inbox still
//     resolves to the claim store's portable primary — the schema rename
//     does not revive the old bootstrap-inbox-as-primary equality.

import test from "node:test";
import assert from "node:assert/strict";

import { NodeCryptoProvider } from "@rezprotocol/node";
import {
  bytesToBase64,
  deriveAccountIdFromPublicKey,
  DeviceRegistrationV1,
  AccountDeviceCapabilityV1,
  ACCOUNT_DEVICE_CAPABILITY_PURPOSE,
  KeystoreStore,
} from "@rezprotocol/core";
import {
  createDelegatedKeystoreAccount,
  unlockKeystoreAccount,
  createKeystoreEnvelope,
  getDefaultKdfParams,
  deriveUnlockKey,
  encryptKeystore,
  decryptKeystore,
  toBase64,
  randomBytes,
} from "@rezprotocol/sdk/client";

import { prepareDelegatedCoreBoot } from "../src/mobile/prepareDelegatedCoreBoot.js";
import { mapUnlockedAccountToRuntimeIdentity } from "../src/server/bootstrap/unlockedAccountIdentity.js";
import { InboxClaimant } from "../src/server/inbox/InboxClaimant.js";
import { PORTABLE_PRIMARY_INBOX_KEY } from "../src/server/inbox/PortableInboxEstablisher.js";

const CRYPTO = new NodeCryptoProvider();
const silentLogger = { log() {}, info() {}, warn() {}, error() {}, debug() {} };

const BOOTSTRAP_INBOX = "inbox:" + "a".repeat(24);
const PORTABLE_INBOX = "inbox:" + "b".repeat(24);
const NOW = Date.now();
const FAR = NOW + 7 * 24 * 60 * 60 * 1000;

function makeKv() {
  const m = new Map();
  return {
    async get(k) { return m.has(k) ? m.get(k) : null; },
    async set(k, v) { m.set(k, JSON.parse(JSON.stringify(v))); },
    async delete(k) { m.delete(k); },
  };
}

function makeStorage() {
  const kv = makeKv();
  return { kv, provider: { getKeyValueStore: () => kv } };
}

function memoryEnvelopeStorage() {
  const map = new Map();
  return {
    get(key) { return map.has(key) ? map.get(key) : null; },
    put(key, value) { map.set(key, value); },
    del(key) { map.delete(key); },
  };
}

function buildLeafCert({ accountPubB64, accountPrivBytes, granteePubB64 }) {
  const fields = {
    v: 1,
    purpose: ACCOUNT_DEVICE_CAPABILITY_PURPOSE,
    accountIdentityPublicKeyB64: accountPubB64,
    parentCertId: null,
    granteeDevicePublicKeyB64: granteePubB64,
    granteeDeviceId: DeviceRegistrationV1.deviceIdFor(granteePubB64),
    capabilities: ["peerLink.create", "deviceSet.publish"],
    maxDelegationDepth: 0,
    issuedAtMs: NOW - 1000,
    expiresAtMs: FAR,
    signerPublicKeyB64: accountPubB64,
  };
  const certId = AccountDeviceCapabilityV1.deriveCertId(fields);
  const sigBytes = CRYPTO.sign({ privateKey: accountPrivBytes, msg: AccountDeviceCapabilityV1.signableBytes({ ...fields, certId }) });
  return new AccountDeviceCapabilityV1({ ...fields, certId, sig: { alg: "ed25519", sigB64: bytesToBase64(sigBytes) } });
}

// A real delegated bundle (B root, C, single-hop chain, account DH pair) —
// the shape createDelegatedKeystoreAccount validates and seals.
function makeDelegation() {
  const b = CRYPTO.generateSigningKeyPair();
  const c = CRYPTO.generateSigningKeyPair();
  const dh = CRYPTO.dhGenerateKeyPair();
  const accountPubB64 = bytesToBase64(b.publicKey);
  const deviceKeyPair = { publicKeyB64: bytesToBase64(c.publicKey), privateKeyB64: bytesToBase64(c.privateKey) };
  const leafCert = buildLeafCert({ accountPubB64, accountPrivBytes: b.privateKey, granteePubB64: deviceKeyPair.publicKeyB64 });
  b.privateKey.fill(0);
  return {
    accountId: deriveAccountIdFromPublicKey(Uint8Array.from(Buffer.from(accountPubB64, "base64"))),
    delegation: {
      accountSignPublicKeyB64: accountPubB64,
      accountDhKeyPair: { publicKeyB64: bytesToBase64(dh.publicKey), privateKeyB64: bytesToBase64(dh.privateKey) },
      deviceKeyPair,
      certChain: [leafCert.toJSON()],
      cachedDeviceSet: null,
    },
  };
}

// An unlocked-result-shaped delegated fixture (no sealing round-trip needed
// for the pure-mapping cases).
function makeUnlocked({ bootstrapInboxId = BOOTSTRAP_INBOX } = {}) {
  const { accountId, delegation } = makeDelegation();
  return {
    hasAdminRoot: false,
    accountId,
    deviceId: DeviceRegistrationV1.deviceIdFor(delegation.deviceKeyPair.publicKeyB64),
    identityPublicKey: delegation.accountSignPublicKeyB64,
    identityKeyPair: null,
    deviceKeyPair: delegation.deviceKeyPair,
    accountIdentityDhKeyPair: delegation.accountDhKeyPair,
    certChain: delegation.certChain,
    cachedDeviceSet: null,
    bootstrapInboxId,
    profileName: "Phone",
  };
}

function baseOpts({ storage, unlocked }) {
  return {
    unlocked,
    storageProvider: storage.provider,
    cryptoProvider: CRYPTO,
    uplinks: ["ws://portable.example/ws"],
    wsFactory: () => ({}),
    logger: silentLogger,
  };
}

test("happy path: returns EXACTLY the startRezChatCore inputs — claimant mode, portable-role identity, bootstrapInboxId as metadata only", async () => {
  const storage = makeStorage();
  await storage.kv.set(PORTABLE_PRIMARY_INBOX_KEY, PORTABLE_INBOX);
  const unlocked = makeUnlocked();

  const inputs = await prepareDelegatedCoreBoot(baseOpts({ storage, unlocked }));

  assert.deepEqual(Object.keys(inputs).sort(), [
    "clock", "cryptoProvider", "deviceKey", "expectedNodePublicKeyB64", "identity",
    "logger", "retentionClass", "sessionMode", "storageProvider", "uplinks", "wsFactory",
  ], "exactly the startRezChatCore input set — nothing extra, nothing missing");
  assert.equal(inputs.sessionMode, "claimant");
  assert.equal(inputs.retentionClass, "standard");
  assert.equal(inputs.storageProvider, storage.provider);
  assert.equal(inputs.cryptoProvider, CRYPTO);
  assert.deepEqual(inputs.uplinks, ["ws://portable.example/ws"]);

  assert.equal(inputs.identity.hasAdminRoot, false);
  assert.equal(inputs.identity.accountId, unlocked.accountId);
  assert.equal(inputs.identity.publicKeyB64, unlocked.identityPublicKey);
  assert.equal(inputs.identity.privateKeyB64, "", "no account signing key can ride into the boot");
  assert.deepEqual(inputs.identity.certChain, unlocked.certChain);
  assert.deepEqual(inputs.identity.accountIdentityDhKeyPair, unlocked.accountIdentityDhKeyPair);
  assert.equal(inputs.identity.inboxId, BOOTSTRAP_INBOX,
    "bootstrapInboxId rides as enrollment metadata (the portable role's ≠-defense) — never the runtime inbox selector");
  assert.equal(inputs.deviceKey.deviceId, unlocked.deviceId);
  assert.deepEqual(inputs.deviceKey.deviceKeyPair, unlocked.deviceKeyPair);
});

test("admin/root authority is rejected: hasAdminRoot, or an account signing keypair riding along", async () => {
  const storage = makeStorage();
  await storage.kv.set(PORTABLE_PRIMARY_INBOX_KEY, PORTABLE_INBOX);

  const primaryShaped = { ...makeUnlocked(), hasAdminRoot: true };
  await assert.rejects(
    () => prepareDelegatedCoreBoot(baseOpts({ storage, unlocked: primaryShaped })),
    /admin\/root authority/,
  );

  const smuggled = { ...makeUnlocked(), identityKeyPair: { publicKeyB64: "x", privateKeyB64: "y" } };
  await assert.rejects(
    () => prepareDelegatedCoreBoot(baseOpts({ storage, unlocked: smuggled })),
    /NO account signing keypair/,
  );
});

test("an envelope without bootstrapInboxId is not a mobile enrollment envelope — refused", async () => {
  const storage = makeStorage();
  await storage.kv.set(PORTABLE_PRIMARY_INBOX_KEY, PORTABLE_INBOX);
  const unlocked = makeUnlocked();
  unlocked.bootstrapInboxId = null;
  await assert.rejects(
    () => prepareDelegatedCoreBoot(baseOpts({ storage, unlocked })),
    /no bootstrapInboxId/,
  );
});

test("no portable primary → ENROLLMENT_INCOMPLETE — even when the claim store holds the BOOTSTRAP claim (the exact rejected fallback)", async () => {
  const storage = makeStorage();
  // The store is not merely empty: the enrollment claim for the bootstrap
  // inbox EXISTS (a killed-after-enrollment phone looks exactly like this).
  // The mapper must say "resume activation", never "boot on what's there".
  await InboxClaimant.bootstrap({
    storageProvider: storage.provider,
    cryptoProvider: CRYPTO,
    delegatedInboxId: BOOTSTRAP_INBOX,
    role: "enrollment",
  });

  let thrown = null;
  try {
    await prepareDelegatedCoreBoot(baseOpts({ storage, unlocked: makeUnlocked() }));
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown, "the mapping must refuse");
  assert.equal(thrown.code, "ENROLLMENT_INCOMPLETE");
  assert.match(thrown.message, /NOT a fallback/);
});

test("portable primary equal to the bootstrap inbox is an invariant violation", async () => {
  const storage = makeStorage();
  await storage.kv.set(PORTABLE_PRIMARY_INBOX_KEY, BOOTSTRAP_INBOX);
  await assert.rejects(
    () => prepareDelegatedCoreBoot(baseOpts({ storage, unlocked: makeUnlocked() })),
    /split-transport invariant/,
  );
});

// Hand-seal a payload through the REAL keystore envelope crypto so the
// legacy shape exercises the real unlock path.
async function writeRawKeystore({ store, password, payload }) {
  const saltBytes = randomBytes(16, null);
  const kdfParams = getDefaultKdfParams(null);
  const unlockKeyBytes = await deriveUnlockKey({ password, saltBytes, kdfParams, cryptoProvider: null });
  const plaintextJsonBytes = new TextEncoder().encode(JSON.stringify(payload));
  const { ciphertextBytes } = await encryptKeystore({ unlockKeyBytes, plaintextJsonBytes, cryptoProvider: null });
  const envelope = createKeystoreEnvelope({
    kdfParams,
    saltB64: toBase64(saltBytes),
    ciphertextB64: toBase64(ciphertextBytes),
    createdAtMs: NOW,
    updatedAtMs: NOW,
  });
  await store.putKeystoreEnvelope(envelope);
}

test("LEGACY COMPAT: an old envelope sealed with generic `inboxId` unlocks as bootstrapInboxId, maps cleanly, and the runtime inbox STILL resolves to the portable primary", async () => {
  // Seal a real delegated envelope, then rewrite its payload to the LEGACY
  // field name and re-seal through the real crypto.
  const { delegation } = makeDelegation();
  const envelopeStore = new KeystoreStore({ storageProvider: memoryEnvelopeStorage() });
  await createDelegatedKeystoreAccount({
    password: "pw",
    profileName: "Phone",
    keystoreStore: envelopeStore,
    delegation: { ...delegation, bootstrapInboxId: BOOTSTRAP_INBOX },
  });
  const sealed = await envelopeStore.getKeystoreEnvelope();
  const saltBytes = Uint8Array.from(Buffer.from(sealed.saltB64, "base64"));
  const unlockKeyBytes = await deriveUnlockKey({ password: "pw", saltBytes, kdfParams: sealed.kdfParams, cryptoProvider: null });
  const payload = JSON.parse(new TextDecoder().decode(await decryptKeystore({ unlockKeyBytes, envelope: sealed, cryptoProvider: null })));
  assert.equal(payload.bootstrapInboxId, BOOTSTRAP_INBOX);
  const legacyShaped = { ...payload, inboxId: payload.bootstrapInboxId };
  delete legacyShaped.bootstrapInboxId;
  await writeRawKeystore({ store: envelopeStore, password: "pw", payload: legacyShaped });

  const unlocked = await unlockKeystoreAccount({ password: "pw", keystoreStore: envelopeStore });
  assert.equal(unlocked.bootstrapInboxId, BOOTSTRAP_INBOX, "the legacy field deserializes AS bootstrapInboxId");
  assert.equal(unlocked.inboxId, undefined, "the generic name is gone from the unlock result");

  // The mapping consumes it identically — and the RUNTIME inbox still comes
  // from the claim store's portable primary, never the legacy value: the
  // rename cannot revive the old bootstrap-inbox-as-primary equality.
  const storage = makeStorage();
  await storage.kv.set(PORTABLE_PRIMARY_INBOX_KEY, PORTABLE_INBOX);
  const inputs = await prepareDelegatedCoreBoot(baseOpts({ storage, unlocked }));
  assert.equal(inputs.identity.inboxId, BOOTSTRAP_INBOX, "metadata only");

  // Boot-time resolution over the same storage (a claim record must exist
  // for the pointer): the portable role selects the PORTABLE inbox.
  const claimStore = (await InboxClaimant.bootstrap({
    storageProvider: storage.provider,
    cryptoProvider: CRYPTO,
    delegatedInboxId: BOOTSTRAP_INBOX,
    role: "enrollment",
  })).claimStore;
  const fresh = await claimStore.createClaim({ inboxId: PORTABLE_INBOX });
  await claimStore.persist(fresh);
  const claimant = await InboxClaimant.bootstrap({
    storageProvider: storage.provider,
    cryptoProvider: CRYPTO,
    delegatedInboxId: inputs.identity.inboxId,
    role: "portable",
    claimStore,
  });
  assert.equal(claimant.inboxId, PORTABLE_INBOX, "the runtime inbox is the portable primary");
  assert.notEqual(claimant.inboxId, BOOTSTRAP_INBOX);
});

test("SSOT projection: the extracted browser mapping handles the PRIMARY shape unchanged (admin root, no inbox seed)", () => {
  const kp = CRYPTO.generateSigningKeyPair();
  const c = CRYPTO.generateSigningKeyPair();
  const mapped = mapUnlockedAccountToRuntimeIdentity({
    hasAdminRoot: true,
    accountId: deriveAccountIdFromPublicKey(kp.publicKey),
    deviceId: DeviceRegistrationV1.deviceIdFor(bytesToBase64(c.publicKey)),
    identityKeyPair: { publicKeyB64: bytesToBase64(kp.publicKey), privateKeyB64: bytesToBase64(kp.privateKey) },
    deviceKeyPair: { publicKeyB64: bytesToBase64(c.publicKey), privateKeyB64: bytesToBase64(c.privateKey) },
    accountIdentityDhKeyPair: null,
  });
  assert.equal(mapped.hasAdminRoot, true);
  assert.equal(mapped.identity.hasAdminRoot, true);
  assert.equal(mapped.identity.publicKeyB64, bytesToBase64(kp.publicKey));
  assert.equal(mapped.identity.privateKeyB64, bytesToBase64(kp.privateKey));
  assert.equal(mapped.identity.certChain, null);
  assert.equal(mapped.identity.inboxId, null, "a primary account seeds no delegated inbox");
});
