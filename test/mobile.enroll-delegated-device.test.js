// P1.3a (plans/P1_3_ENROLLMENT_TRACE.md §8) — enrollDelegatedDevice
// composition contract. The SDK requester's ceremony crypto is covered in
// rez-sdk; what THIS suite pins is the module's own boundary:
//
//   - fail loud on every missing provider, BEFORE any network touch
//   - refuse an occupied keystoreStore before the ceremony starts (a
//     persist-doomed ceremony would still commit device.add and burn the code)
//   - the persistDelegation it supplies REALLY seals the delegated envelope
//     (real createDelegatedKeystoreAccount, real KeystoreStore) before the
//     requester may confirm
//   - a missing bootstrap inboxId fails PRE-SEAL (still pre-confirm)
//   - a post-persist ceremony failure clears the envelope and rethrows;
//     a pre-persist failure leaves nothing durable
//   - the throwaway rendezvous client is closed on every path
//
// The full real-transport ceremony is e2e.local-mesh.mobile-enroll.test.js.

import test from "node:test";
import assert from "node:assert/strict";

import {
  bytesToBase64,
  deriveAccountIdFromPublicKey,
  DeviceRegistrationV1,
  AccountDeviceCapabilityV1,
  ACCOUNT_DEVICE_CAPABILITY_PURPOSE,
} from "@rezprotocol/core";
import { NodeCryptoProvider } from "@rezprotocol/node";
import { KeystoreStore, unlockKeystoreAccount } from "@rezprotocol/sdk/client";
import { enrollDelegatedDevice } from "../src/mobile/enrollDelegatedDevice.js";

const CRYPTO = new NodeCryptoProvider();
const NOW = Date.now();
const FAR = NOW + 7 * 24 * 60 * 60 * 1000;

const silentLogger = { log() {}, info() {}, warn() {}, error() {}, debug() {} };

function memoryStorageProvider() {
  const map = new Map();
  return {
    get(key) { return map.has(key) ? map.get(key) : null; },
    put(key, value) { map.set(key, value); },
    del(key) { map.delete(key); },
  };
}

function makeKeystoreStore() {
  return new KeystoreStore({ storageProvider: memoryStorageProvider() });
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

// A requester-result fixture minted the way the ceremony would: real B root,
// real device key C, single-hop chain, account X25519 DH key, self-minted
// bootstrap inbox. B's private key is zeroed after signing.
function makeCeremonyResult() {
  const b = CRYPTO.generateSigningKeyPair();
  const c = CRYPTO.generateSigningKeyPair();
  const dh = CRYPTO.dhGenerateKeyPair();
  const accountPubB64 = bytesToBase64(b.publicKey);
  const deviceKeyPair = { publicKeyB64: bytesToBase64(c.publicKey), privateKeyB64: bytesToBase64(c.privateKey) };
  const leafCert = buildLeafCert({ accountPubB64, accountPrivBytes: b.privateKey, granteePubB64: deviceKeyPair.publicKeyB64 });
  b.privateKey.fill(0);
  let inboxHex = "";
  // Canonical inbox shape: "inbox:" + 24 lowercase hex chars (12 random bytes).
  for (const byte of CRYPTO.randomBytes(12)) inboxHex += byte.toString(16).padStart(2, "0");
  return {
    expectedAccountId: deriveAccountIdFromPublicKey(b.publicKey),
    expectedDeviceId: DeviceRegistrationV1.deviceIdFor(deviceKeyPair.publicKeyB64),
    delegation: {
      accountSignPublicKeyB64: accountPubB64,
      accountDhKeyPair: { publicKeyB64: bytesToBase64(dh.publicKey), privateKeyB64: bytesToBase64(dh.privateKey) },
      deviceKeyPair,
      certChain: [leafCert.toJSON()],
      cachedDeviceSet: null,
    },
    deviceId: DeviceRegistrationV1.deviceIdFor(deviceKeyPair.publicKeyB64),
    inboxId: "inbox:" + inboxHex,
    fingerprint: "AB-CD-EF",
  };
}

function makeSdkHarness() {
  const calls = { factory: 0, connect: 0, close: 0, factoryOpts: null };
  const sdk = {
    connect: async () => { calls.connect += 1; },
    close: async () => { calls.close += 1; },
    durableRecords: { put: async () => ({}), get: async () => null },
  };
  const factory = (opts) => { calls.factory += 1; calls.factoryOpts = opts; return sdk; };
  return { calls, factory };
}

function baseOpts(overrides = {}) {
  const harness = makeSdkHarness();
  return {
    harness,
    opts: {
      linkCode: "rez:link:v1:code",
      password: "unlock-secret",
      profileName: "Phone",
      cryptoProvider: CRYPTO,
      wsFactory: () => ({}),
      uplinks: ["ws://127.0.0.1:1/ws"],
      keystoreStore: makeKeystoreStore(),
      logger: silentLogger,
      sdkFactory: harness.factory,
      ...overrides,
    },
  };
}

test("every missing provider fails loud BEFORE the rendezvous client exists", async () => {
  const variants = [
    [{ linkCode: "" }, /requires linkCode/],
    [{ password: "" }, /requires password/],
    [{ cryptoProvider: null }, /requires cryptoProvider/],
    [{ wsFactory: null }, /requires wsFactory/],
    [{ uplinks: [] }, /requires uplinks/],
    [{ keystoreStore: { hasKeystore() {}, putKeystoreEnvelope() {} } }, /requires keystoreStore/],
    [{ clock: "now" }, /requires clock/],
  ];
  for (const [override, pattern] of variants) {
    const { harness, opts } = baseOpts(override);
    await assert.rejects(() => enrollDelegatedDevice(opts), pattern);
    assert.equal(harness.calls.factory, 0, "no client was constructed for " + JSON.stringify(override));
  }
});

test("an occupied keystoreStore refuses before any network touch — a persist-doomed ceremony must never start", async () => {
  const occupied = {
    hasKeystore: async () => true,
    putKeystoreEnvelope: async () => { throw new Error("unreachable"); },
    clearKeystore: async () => { throw new Error("unreachable"); },
  };
  const { harness, opts } = baseOpts({ keystoreStore: occupied });
  await assert.rejects(() => enrollDelegatedDevice(opts), /already holds an envelope/);
  assert.equal(harness.calls.factory, 0, "the rendezvous client was never constructed");
});

test("happy path: the envelope is sealed DURABLY before the requester returns, and the module returns exactly the envelope's identity facts", async () => {
  const fixture = makeCeremonyResult();
  const clock = () => NOW;
  const store = makeKeystoreStore();
  let requesterOpts = null;
  let durableBeforeConfirm = null;
  const requester = async (opts) => {
    requesterOpts = opts;
    const persistence = await opts.persistDelegation(fixture);
    // The requester publishes its confirm only after persistDelegation
    // resolves — so durability HERE is durability before confirmation.
    durableBeforeConfirm = await store.hasKeystore();
    return { ...fixture, persistence };
  };
  const { harness, opts } = baseOpts({ requester, clock, keystoreStore: store });

  const result = await enrollDelegatedDevice(opts);

  assert.deepEqual(result, {
    accountId: fixture.expectedAccountId,
    deviceId: fixture.expectedDeviceId,
    bootstrapInboxId: fixture.inboxId,
  });
  assert.equal(durableBeforeConfirm, true, "the envelope was durable before the requester could confirm");

  // The composition threads exactly the injected seams to the ceremony.
  assert.equal(requesterOpts.code, "rez:link:v1:code");
  assert.equal(requesterOpts.crypto, CRYPTO);
  assert.equal(requesterOpts.nowMs, clock);
  assert.equal(harness.calls.connect, 1);
  assert.equal(harness.calls.close, 1, "the throwaway rendezvous client is closed on success");
  const identity = harness.calls.factoryOpts.identity;
  assert.ok(identity.publicKeyB64 && identity.privateKeyB64, "the rendezvous session rides a throwaway self-generated identity");
  assert.notEqual(identity.publicKeyB64, fixture.delegation.deviceKeyPair.publicKeyB64, "the session key is NOT the device key C");

  // The sealed envelope round-trips as a delegated account: no admin root,
  // the ceremony's device key, the ceremony's bootstrap inbox.
  // cryptoProvider here is the WEBCRYPTO seam (null → globalThis.crypto),
  // NOT the RCryptoProvider — same distinction the module documents.
  const unlocked = await unlockKeystoreAccount({
    password: "unlock-secret",
    keystoreStore: opts.keystoreStore,
  });
  assert.equal(unlocked.hasAdminRoot, false);
  assert.equal(unlocked.identityKeyPair, null, "no account signing key exists in the envelope");
  assert.equal(unlocked.accountId, fixture.expectedAccountId);
  assert.equal(unlocked.deviceId, fixture.expectedDeviceId);
  assert.equal(unlocked.deviceKeyPair.publicKeyB64, fixture.delegation.deviceKeyPair.publicKeyB64);
  assert.equal(unlocked.bootstrapInboxId, fixture.inboxId, "the envelope carries the ceremony's bootstrap inbox under the honest R3 name");
});

test("a ceremony result without a bootstrap inboxId fails PRE-SEAL — nothing durable, still pre-confirm", async () => {
  const fixture = makeCeremonyResult();
  const broken = { ...fixture, inboxId: undefined };
  const requester = async (opts) => {
    const persistence = await opts.persistDelegation(broken);
    return { ...broken, persistence };
  };
  const { opts } = baseOpts({ requester });
  await assert.rejects(() => enrollDelegatedDevice(opts), /no bootstrap inboxId/);
  assert.equal(await opts.keystoreStore.hasKeystore(), false, "nothing was sealed");
});

test("a post-persist ceremony failure clears the envelope and rethrows — the primary's journal owns the compensating revoke", async () => {
  const fixture = makeCeremonyResult();
  const requester = async (opts) => {
    await opts.persistDelegation(fixture);
    throw new Error("confirm publish failed");
  };
  const { harness, opts } = baseOpts({ requester });
  await assert.rejects(() => enrollDelegatedDevice(opts), /confirm publish failed/);
  assert.equal(await opts.keystoreStore.hasKeystore(), false, "the unconfirmed envelope must not remain looking usable");
  assert.equal(harness.calls.close, 1, "the rendezvous client is closed on failure");
});

test("a pre-persist ceremony failure leaves nothing durable — honest kill behavior, ceremony restart", async () => {
  const requester = async () => { throw new Error("primary never answered"); };
  const { harness, opts } = baseOpts({ requester });
  await assert.rejects(() => enrollDelegatedDevice(opts), /primary never answered/);
  assert.equal(await opts.keystoreStore.hasKeystore(), false);
  assert.equal(harness.calls.close, 1);
});

test("a failing clearKeystore is reported loudly but never masks the ceremony error", async () => {
  const fixture = makeCeremonyResult();
  const inner = makeKeystoreStore();
  const store = {
    hasKeystore: () => inner.hasKeystore(),
    putKeystoreEnvelope: (envelope) => inner.putKeystoreEnvelope(envelope),
    clearKeystore: async () => { throw new Error("storage went away"); },
  };
  const errors = [];
  const logger = { ...silentLogger, error: (...args) => { errors.push(args.join(" ")); } };
  const requester = async (opts) => {
    await opts.persistDelegation(fixture);
    throw new Error("confirm publish failed");
  };
  const { opts } = baseOpts({ requester, keystoreStore: store, logger });
  await assert.rejects(() => enrollDelegatedDevice(opts), /confirm publish failed/);
  assert.equal(errors.length, 1, "the stranded-envelope condition was reported");
  assert.match(errors[0], /stranded delegated envelope/);
});
