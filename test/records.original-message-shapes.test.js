// AE-1 (plans/ORIGINAL_MESSAGE_ANTIENTROPY_PLAN.md): canonical-bytes /
// MessageFingerprint vectors and the admission matrix, against the ONE
// shapes SSOT (records/payloads/originalMessageShapes.js). Real crypto
// (NodeCryptoProvider) and real rez-core cert records — no mocks, per the
// DesktopSupervisor war story.

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

import {
  ORIGINAL_MESSAGE_KINDS,
  ORIGINAL_MESSAGE_MUTATION_KINDS,
  isOriginalMessageKind,
  originalMessageAuthPresence,
  signableOriginalMessagePayload,
  signableOriginalMessageBytes,
  messageFingerprint,
  verifyOriginalMessageForAdmission,
} from "../src/records/payloads/originalMessageShapes.js";
import { ChatMessagePayloadV1, MESSAGE_KIND } from "../src/records/payloads/ChatMessagePayloadV1.js";
import { MESSAGE_EDIT_KIND } from "../src/records/payloads/ChatMessageEditPayloadV1.js";
import { MESSAGE_TOMBSTONE_KIND } from "../src/records/payloads/ChatMessageTombstonePayloadV1.js";
import { REACTION_KIND } from "../src/records/payloads/ChatReactionPayloadV1.js";

const CRYPTO = new NodeCryptoProvider();
const NOW = 1756000000000;
const FAR = NOW + 7 * 24 * 60 * 60 * 1000;

function buildLeafCert({ accountPubB64, accountPrivBytes, granteePubB64, capabilities = ["peerLink.create"] }) {
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
  const sigBytes = CRYPTO.sign({
    privateKey: accountPrivBytes,
    msg: AccountDeviceCapabilityV1.signableBytes({ ...fields, certId }),
  });
  return new AccountDeviceCapabilityV1({ ...fields, certId, sig: { alg: "ed25519", sigB64: bytesToBase64(sigBytes) } }).toJSON();
}

// A DIRECT-mode (account root B signs) signed base message, as raw wire JSON.
function directIdentity() {
  const b = CRYPTO.generateSigningKeyPair();
  return {
    keyPair: b,
    accountPubB64: bytesToBase64(b.publicKey),
    accountId: deriveAccountIdFromPublicKey(b.publicKey),
  };
}

function baseSemantic(identity, overrides = {}) {
  return {
    kind: MESSAGE_KIND,
    threadId: "th_shapes",
    senderAccountId: identity.accountId,
    messageId: "m1",
    text: "hello facts",
    inReplyToMessageId: "",
    channelId: "",
    signerPublicKeyB64: identity.accountPubB64,
    senderDeviceId: "",
    senderAuthorityEpoch: 3,
    ...overrides,
  };
}

function signDirect(identity, semantic) {
  const sigBytes = CRYPTO.sign({ privateKey: identity.keyPair.privateKey, msg: signableOriginalMessageBytes(semantic) });
  return {
    ...semantic,
    senderCertChain: [],
    contentHash: messageFingerprint(semantic),
    sig: bytesToBase64(sigBytes),
  };
}

test("kind sets: the four chat kinds, three of them mutations", () => {
  assert.deepEqual([...ORIGINAL_MESSAGE_KINDS], [MESSAGE_KIND, MESSAGE_EDIT_KIND, MESSAGE_TOMBSTONE_KIND, REACTION_KIND]);
  assert.deepEqual([...ORIGINAL_MESSAGE_MUTATION_KINDS], [MESSAGE_EDIT_KIND, MESSAGE_TOMBSTONE_KIND, REACTION_KIND]);
  assert.equal(isOriginalMessageKind(MESSAGE_KIND), true);
  assert.equal(isOriginalMessageKind("rez.chat.image.v1"), false);
});

test("fingerprint covers exactly the semantic fields: envelope fields excluded, key order irrelevant", () => {
  const id = directIdentity();
  const semantic = baseSemantic(id);
  const fp = messageFingerprint(semantic);

  // sig / senderCertChain / contentHash are VERIFICATION MATERIAL — a
  // re-signed or re-chained identical fact keeps its fingerprint.
  assert.equal(messageFingerprint({ ...semantic, sig: "AAAA", contentHash: "beef", senderCertChain: [{ x: 1 }] }), fp);

  // Insertion order must not matter (canonical JSON).
  const reordered = {};
  for (const key of Object.keys(semantic).reverse()) reordered[key] = semantic[key];
  assert.equal(messageFingerprint(reordered), fp);

  // EVERY semantic field is inside the signed bytes (frozen canonical-bytes
  // rule): changing any one changes the fingerprint.
  const variants = [
    { text: "tampered" },
    { messageId: "m2" },
    { threadId: "th_other" },
    { senderAccountId: id.accountId + "x" },
    { signerPublicKeyB64: bytesToBase64(CRYPTO.generateSigningKeyPair().publicKey) },
    { senderDeviceId: "rez:dev:deadbeef" },
    { senderAuthorityEpoch: 4 },
    { inReplyToMessageId: "m0" },
    { channelId: "general" },
  ];
  for (const change of variants) {
    assert.notEqual(messageFingerprint({ ...semantic, ...change }), fp,
      "expected fingerprint change for " + JSON.stringify(change));
  }
});

test("the record round-trip is fingerprint-stable (coerced wire JSON signs identically)", () => {
  const id = directIdentity();
  const semantic = baseSemantic(id, { threadId: "  th_shapes  ", messageId: " m1 " });
  const coerced = new ChatMessagePayloadV1(semantic).toJSON();
  // Signing operates on the COERCED draft (the sender's two-phase build);
  // the receiver recomputes from the wire JSON — must agree.
  const fp = messageFingerprint(coerced);
  assert.equal(messageFingerprint(new ChatMessagePayloadV1(coerced).toJSON()), fp);
});

test("mutations must carry targetFingerprint inside the signed bytes (binding requirement)", () => {
  const id = directIdentity();
  for (const kind of ORIGINAL_MESSAGE_MUTATION_KINDS) {
    const semantic = {
      kind,
      threadId: "th_shapes",
      senderAccountId: id.accountId,
      targetMessageId: "m1",
      signerPublicKeyB64: id.accountPubB64,
      senderDeviceId: "",
      senderAuthorityEpoch: 0,
      newText: "e",
      editedAtMs: NOW,
      tombstonedAtMs: NOW,
      emoji: "x",
      op: "add",
      createdAtMs: NOW,
    };
    assert.throws(() => signableOriginalMessagePayload(semantic), /targetFingerprint/);
    const withTarget = { ...semantic, targetFingerprint: "f".repeat(64) };
    const fp = messageFingerprint(withTarget);
    assert.notEqual(messageFingerprint({ ...withTarget, targetFingerprint: "e".repeat(64) }), fp,
      kind + ": targetFingerprint must be inside the signed bytes");
  }
});

test("auth presence group is all-or-none; partial is malformed", () => {
  const id = directIdentity();
  const signed = signDirect(id, baseSemantic(id));
  assert.equal(originalMessageAuthPresence(signed), "all");
  assert.equal(originalMessageAuthPresence(baseSemantic(id, { signerPublicKeyB64: "", senderAuthorityEpoch: null })), "none");
  assert.equal(originalMessageAuthPresence({ ...signed, sig: "" }), "partial");
  assert.equal(originalMessageAuthPresence({ ...signed, senderAuthorityEpoch: null }), "partial");
});

test("admission: a valid DIRECT-mode record verifies; fingerprint is returned", async () => {
  const id = directIdentity();
  const signed = signDirect(id, baseSemantic(id));
  const result = await verifyOriginalMessageForAdmission({ payloadJson: signed, cryptoProvider: CRYPTO, nowMs: NOW });
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.mode, "direct");
  assert.equal(result.fingerprint, signed.contentHash);
});

test("admission matrix (direct mode): tampered content, wrong hash, bad sig, wrong account all fail closed", async () => {
  const id = directIdentity();
  const signed = signDirect(id, baseSemantic(id));

  const tampered = await verifyOriginalMessageForAdmission({
    payloadJson: { ...signed, text: "evil" }, cryptoProvider: CRYPTO, nowMs: NOW,
  });
  assert.equal(tampered.ok, false);
  assert.match(tampered.reason, /contentHash/);

  const badHash = await verifyOriginalMessageForAdmission({
    payloadJson: { ...signed, contentHash: "0".repeat(64) }, cryptoProvider: CRYPTO, nowMs: NOW,
  });
  assert.equal(badHash.ok, false);

  const otherKey = CRYPTO.generateSigningKeyPair();
  const badSig = await verifyOriginalMessageForAdmission({
    payloadJson: { ...signed, sig: bytesToBase64(CRYPTO.sign({ privateKey: otherKey.privateKey, msg: signableOriginalMessageBytes(signed) })) },
    cryptoProvider: CRYPTO,
    nowMs: NOW,
  });
  assert.equal(badSig.ok, false);
  assert.match(badSig.reason, /signature/);

  // The signer key must DERIVE the claimed senderAccountId (self-certifying
  // identity — an attacker signing with their own key cannot claim another
  // account).
  const impostor = directIdentity();
  const impostorSemantic = baseSemantic(impostor, { senderAccountId: id.accountId });
  const impostorSigned = signDirect(impostor, impostorSemantic);
  const impersonation = await verifyOriginalMessageForAdmission({ payloadJson: impostorSigned, cryptoProvider: CRYPTO, nowMs: NOW });
  assert.equal(impersonation.ok, false);
  assert.match(impersonation.reason, /anchor does not derive senderAccountId/);
});

test("admission (cert mode): device-signed under a valid chain verifies; chain games fail closed", async () => {
  const account = directIdentity();
  const device = CRYPTO.generateSigningKeyPair();
  const devicePubB64 = bytesToBase64(device.publicKey);
  const deviceId = DeviceRegistrationV1.deviceIdFor(devicePubB64);
  const leaf = buildLeafCert({
    accountPubB64: account.accountPubB64,
    accountPrivBytes: account.keyPair.privateKey,
    granteePubB64: devicePubB64,
  });

  const semantic = baseSemantic(account, { signerPublicKeyB64: devicePubB64, senderDeviceId: deviceId });
  const sigBytes = CRYPTO.sign({ privateKey: device.privateKey, msg: signableOriginalMessageBytes(semantic) });
  const signed = {
    ...semantic,
    senderCertChain: [leaf],
    contentHash: messageFingerprint(semantic),
    sig: bytesToBase64(sigBytes),
  };

  const ok = await verifyOriginalMessageForAdmission({ payloadJson: signed, cryptoProvider: CRYPTO, nowMs: NOW });
  assert.equal(ok.ok, true, ok.reason);
  assert.equal(ok.mode, "delegated");

  // senderDeviceId must be the self-cert of the signed-in signer key.
  const wrongDevice = await verifyOriginalMessageForAdmission({
    payloadJson: { ...signed, senderDeviceId: "rez:dev:" + "0".repeat(16), contentHash: messageFingerprint({ ...semantic, senderDeviceId: "rez:dev:" + "0".repeat(16) }) },
    cryptoProvider: CRYPTO,
    nowMs: NOW,
  });
  assert.equal(wrongDevice.ok, false);

  // A chain anchored to a DIFFERENT account cannot vouch for this sender.
  const otherAccount = directIdentity();
  const foreignLeaf = buildLeafCert({
    accountPubB64: otherAccount.accountPubB64,
    accountPrivBytes: otherAccount.keyPair.privateKey,
    granteePubB64: devicePubB64,
  });
  const foreignChain = await verifyOriginalMessageForAdmission({
    payloadJson: { ...signed, senderCertChain: [foreignLeaf] },
    cryptoProvider: CRYPTO,
    nowMs: NOW,
  });
  assert.equal(foreignChain.ok, false);
  assert.match(foreignChain.reason, /anchor does not derive senderAccountId/);

  // Forward-looking revocation: observed revocation of the leaf blocks NEW
  // admission regardless of the record's own (signed) epoch stamp.
  const revoked = await verifyOriginalMessageForAdmission({
    payloadJson: signed,
    cryptoProvider: CRYPTO,
    nowMs: NOW,
    revocationState: { revokedCertIds: [leaf.certId] },
  });
  assert.equal(revoked.ok, false);
  assert.match(revoked.reason, /revoked/);

  // Cert time windows are enforced with the receiver's clock, never fail-open.
  const expired = await verifyOriginalMessageForAdmission({ payloadJson: signed, cryptoProvider: CRYPTO, nowMs: FAR + 1 });
  assert.equal(expired.ok, false);
  assert.match(expired.reason, /expired/);

  // A cert-mode record without senderDeviceId is malformed.
  const noDeviceSemantic = baseSemantic(account, { signerPublicKeyB64: devicePubB64, senderDeviceId: "" });
  const noDeviceSig = CRYPTO.sign({ privateKey: device.privateKey, msg: signableOriginalMessageBytes(noDeviceSemantic) });
  const noDevice = await verifyOriginalMessageForAdmission({
    payloadJson: {
      ...noDeviceSemantic,
      senderCertChain: [leaf],
      contentHash: messageFingerprint(noDeviceSemantic),
      sig: bytesToBase64(noDeviceSig),
    },
    cryptoProvider: CRYPTO,
    nowMs: NOW,
  });
  assert.equal(noDevice.ok, false);
  assert.match(noDevice.reason, /senderDeviceId/);
});

test("fingerprint identity survives device-local id divergence (eventId fallback / mid@sender)", () => {
  // The SAME logical fact stored under different device-local projection ids
  // (F3: eventId fallback, TRUST-1 mid@sender rewrites) keeps ONE
  // fingerprint — the sync identity is content, not storage accident. The
  // projection id is NOT part of the payload, so nothing about local
  // rekeying can move the fingerprint.
  const id = directIdentity();
  const signed = signDirect(id, baseSemantic(id));
  const fp = messageFingerprint(signed);
  const storedUnderOtherLocalId = JSON.parse(JSON.stringify(signed));
  assert.equal(messageFingerprint(storedUnderOtherLocalId), fp);
});
