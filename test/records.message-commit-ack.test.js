// MessageCommitAckV1 (plans/MESSAGE_COMMIT_ACK_PLAN.md §2): the record, the
// canonical signable bytes (frozen: normalize semantic absence explicitly —
// schema coercion is not canonicalization), and the fail-closed acceptance
// verifier in both signer modes (direct account root / delegated device
// under a capability chain, with forward-looking revocation).

import test from "node:test";
import assert from "node:assert/strict";

import {
  bytesToBase64,
  deriveAccountIdFromPublicKey,
} from "@rezprotocol/sdk/client";
import { NodeCryptoProvider } from "@rezprotocol/node";
import {
  AccountDeviceCapabilityV1,
  ACCOUNT_DEVICE_CAPABILITY_PURPOSE,
  DeviceRegistrationV1,
} from "@rezprotocol/core";

import {
  MessageCommitAckV1,
  MESSAGE_COMMIT_ACK_KIND,
  verifyCommitAckForAcceptance,
} from "../src/records/payloads/MessageCommitAckV1.js";

const CRYPTO = new NodeCryptoProvider();

function makeAccount() {
  const keyPair = CRYPTO.generateSigningKeyPair();
  return {
    keyPair,
    pubB64: bytesToBase64(keyPair.publicKey),
    accountId: deriveAccountIdFromPublicKey(keyPair.publicKey),
  };
}

function semanticFor(account, overrides = {}) {
  return {
    messageId: "m1",
    messageFingerprint: "f".repeat(64),
    threadId: "th_ab",
    recipientAccountId: account.accountId,
    recipientDeviceId: "",
    recipientAuthorityEpoch: 0,
    signerPublicKeyB64: account.pubB64,
    committedAtMs: 1000,
    ...overrides,
  };
}

// A DIRECT-mode ack: the recipient's account root signs the canonical bytes.
function directAck(account, overrides = {}) {
  const semantic = semanticFor(account, overrides);
  const sig = CRYPTO.sign({
    privateKey: account.keyPair.privateKey,
    msg: MessageCommitAckV1.signableBytes(semantic),
  });
  return new MessageCommitAckV1({
    ...semantic,
    recipientCertChain: [],
    sig: bytesToBase64(sig),
  }).toJSON();
}

function leafCertFor(account, deviceKeyPair, { revokedLater = false, expired = false } = {}) {
  const devicePubB64 = bytesToBase64(deviceKeyPair.publicKey);
  const now = Date.now();
  const fields = {
    v: 1,
    purpose: ACCOUNT_DEVICE_CAPABILITY_PURPOSE,
    accountIdentityPublicKeyB64: account.pubB64,
    parentCertId: null,
    granteeDevicePublicKeyB64: devicePubB64,
    granteeDeviceId: DeviceRegistrationV1.deviceIdFor(devicePubB64),
    capabilities: ["peerLink.create"],
    maxDelegationDepth: 0,
    issuedAtMs: now - 2000,
    expiresAtMs: expired ? now - 1000 : now + 86400000,
    signerPublicKeyB64: account.pubB64,
  };
  const certId = AccountDeviceCapabilityV1.deriveCertId(fields);
  const certSig = CRYPTO.sign({
    privateKey: account.keyPair.privateKey,
    msg: AccountDeviceCapabilityV1.signableBytes({ ...fields, certId }),
  });
  const leaf = new AccountDeviceCapabilityV1({
    ...fields,
    certId,
    sig: { alg: "ed25519", sigB64: bytesToBase64(certSig) },
  }).toJSON();
  return { leaf, devicePubB64, deviceId: fields.granteeDeviceId, revokedLater };
}

// A CERT-mode ack: a delegated device signs under the account's chain.
function certModeAck(account, deviceKeyPair, leaf, overrides = {}) {
  const devicePubB64 = bytesToBase64(deviceKeyPair.publicKey);
  const semantic = semanticFor(account, {
    recipientDeviceId: DeviceRegistrationV1.deviceIdFor(devicePubB64),
    signerPublicKeyB64: devicePubB64,
    recipientAuthorityEpoch: 1,
    ...overrides,
  });
  const sig = CRYPTO.sign({
    privateKey: deviceKeyPair.privateKey,
    msg: MessageCommitAckV1.signableBytes(semantic),
  });
  return new MessageCommitAckV1({
    ...semantic,
    recipientCertChain: [leaf],
    sig: bytesToBase64(sig),
  }).toJSON();
}

test("MessageCommitAckV1 validates the claim shape", () => {
  const account = makeAccount();
  const ack = directAck(account);
  assert.equal(ack.kind, MESSAGE_COMMIT_ACK_KIND);
  assert.throws(() => new MessageCommitAckV1({ ...ack, messageFingerprint: "" }), /messageFingerprint/);
  assert.throws(() => new MessageCommitAckV1({ ...ack, committedAtMs: 0 }), /committedAtMs/);
  // Epoch 0 is a legitimate value (a primary that never mutated its device set).
  const epochZero = new MessageCommitAckV1(ack);
  assert.equal(epochZero.recipientAuthorityEpoch, 0);
});

test("signable bytes are stable across the wire round-trip and normalize absence explicitly", () => {
  const account = makeAccount();
  const semantic = semanticFor(account);
  const signedBytes = MessageCommitAckV1.signableBytes(semantic);

  // sign → toJSON → JSON round-trip → re-coerce → recompute (the frozen
  // test shape from the AE-2 lesson).
  const wire = directAck(account);
  const reparsed = new MessageCommitAckV1(JSON.parse(JSON.stringify(wire))).toJSON();
  assert.deepEqual(MessageCommitAckV1.signableBytes(reparsed), signedBytes,
    "receiver-recoerced record canonicalizes to the signed bytes");

  // Absent vs explicit-empty vs null recipientDeviceId are ONE canonical form
  // (schema coercion maps null→"", the builder normalizes the same way).
  const omitted = { ...semantic };
  delete omitted.recipientDeviceId;
  assert.deepEqual(MessageCommitAckV1.signableBytes(omitted), signedBytes);
  assert.deepEqual(MessageCommitAckV1.signableBytes({ ...semantic, recipientDeviceId: null }), signedBytes);
});

test("a direct-mode ack from the recipient account root verifies", async () => {
  const account = makeAccount();
  const verdict = await verifyCommitAckForAcceptance({
    ackJson: directAck(account),
    cryptoProvider: CRYPTO,
    nowMs: Date.now(),
    revocationState: null,
  });
  assert.equal(verdict.ok, true, verdict.reason);
  assert.equal(verdict.mode, "direct");
});

test("a tampered fingerprint or foreign account claim is rejected", async () => {
  const account = makeAccount();
  const other = makeAccount();
  const ack = directAck(account);

  const tampered = await verifyCommitAckForAcceptance({
    ackJson: { ...ack, messageFingerprint: "0".repeat(64) },
    cryptoProvider: CRYPTO,
    nowMs: Date.now(),
  });
  assert.equal(tampered.ok, false);
  assert.match(tampered.reason, /signature/);

  const impersonation = await verifyCommitAckForAcceptance({
    ackJson: { ...ack, recipientAccountId: other.accountId },
    cryptoProvider: CRYPTO,
    nowMs: Date.now(),
  });
  assert.equal(impersonation.ok, false);
  assert.match(impersonation.reason, /anchor does not derive recipientAccountId/);
});

test("a cert-mode ack verifies, requires the device self-cert, and dies with its revoked chain", async () => {
  const account = makeAccount();
  const deviceKp = CRYPTO.generateSigningKeyPair();
  const { leaf } = leafCertFor(account, deviceKp);
  const ack = certModeAck(account, deviceKp, leaf);

  const ok = await verifyCommitAckForAcceptance({
    ackJson: ack,
    cryptoProvider: CRYPTO,
    nowMs: Date.now(),
    revocationState: null,
  });
  assert.equal(ok.ok, true, ok.reason);
  assert.equal(ok.mode, "delegated");

  const noDevice = await verifyCommitAckForAcceptance({
    ackJson: { ...ack, recipientDeviceId: "" },
    cryptoProvider: CRYPTO,
    nowMs: Date.now(),
  });
  assert.equal(noDevice.ok, false);
  assert.match(noDevice.reason, /recipientDeviceId/);

  // Forward-looking revocation: the sender's CURRENT observed authority
  // state rejects the since-revoked device, whatever the ack's epoch claims.
  const revoked = await verifyCommitAckForAcceptance({
    ackJson: ack,
    cryptoProvider: CRYPTO,
    nowMs: Date.now(),
    revocationState: { revokedCertIds: [leaf.certId], minValidIssuedAtMs: 0 },
  });
  assert.equal(revoked.ok, false);
  assert.match(revoked.reason, /revoked/);
});
