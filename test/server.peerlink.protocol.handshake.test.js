import test from "node:test";
import assert from "node:assert/strict";
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as nodeSign,
  verify as nodeVerify,
} from "node:crypto";

import {
  canonicalJSONStringify,
  bytesToBase64,
  createDefaultStorageProvider,
  deriveAccountIdFromPublicKey,
} from "@rezprotocol/sdk/client";
import { PeerLinkService } from "@rezprotocol/sdk/peer-link";
import { NodeCryptoProvider } from "@rezprotocol/node";

import { ServerPeerLinkProtocolService } from "../src/server/services/ServerPeerLinkProtocolService.js";

const CRYPTO = new NodeCryptoProvider();

function signedPayloadBytes(payload) {
  return new TextEncoder().encode(canonicalJSONStringify(payload));
}

function createSessionIdentity() {
  const keyPair = CRYPTO.generateSigningKeyPair();
  return {
    accountId: deriveAccountIdFromPublicKey(keyPair.publicKey),
    publicKey: keyPair.publicKey,
    privateKey: keyPair.privateKey,
    accountIdentityPublicKeyB64: bytesToBase64(keyPair.publicKey),
  };
}

async function provisionPeerLinkBinding({ peerLinks, identity, issuedAtMs = Date.now(), expiresAtMs = Date.now() + 7 * 24 * 60 * 60 * 1000 } = {}) {
  const challenge = await peerLinks.getOrCreateAccountBindingChallenge({ ownerAccountId: identity.accountId });
  const x3dhIdentityPublicKeyB64 = String(challenge && challenge.x3dhIdentityPublicKeyB64 || "").trim();
  const payload = {
    kind: "x3dh-subkey-binding",
    accountId: identity.accountId,
    x3dhIdentityPublicKeyB64,
    issuedAtMs,
    expiresAtMs,
  };
  const sig = CRYPTO.sign({ privateKey: identity.privateKey, msg: signedPayloadBytes(payload) });
  await peerLinks.upsertAccountBinding({
    ownerAccountId: identity.accountId,
    accountBinding: {
      accountId: identity.accountId,
      accountIdentityPublicKeyB64: identity.accountIdentityPublicKeyB64,
      x3dhIdentityPublicKeyB64,
      issuedAtMs,
      expiresAtMs,
      accountBindingSigB64: bytesToBase64(sig),
    },
  });
}

/**
 * Chat-server-side handshake decrypt coverage (Shape A).
 *
 * Replaces the deleted rez-node/test/peer-link.handshake.deposit.test.js, which
 * exercised the node-side handler. After activation, inbound x3dh handshake
 * packets flow through chat-server's ServerPeerLinkProtocolService.
 */

function createInviteAuthority(accountId) {
  const keyId = "invite-ed25519-v1";
  const alg = "ed25519";
  const keyPair = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { format: "der", type: "spki" },
    privateKeyEncoding: { format: "der", type: "pkcs8" },
  });
  const privateKeyObj = createPrivateKey({ key: new Uint8Array(keyPair.privateKey), format: "der", type: "pkcs8" });
  const publicKeyObj = createPublicKey({ key: new Uint8Array(keyPair.publicKey), format: "der", type: "spki" });
  return {
    signer: {
      getSignerRef() {
        return { accountId, keyId, alg };
      },
      async sign(bytes) {
        return new Uint8Array(nodeSign(null, bytes, privateKeyObj));
      },
    },
    verifier: {
      async verify({ signerRef, bytes, sigBytes } = {}) {
        if (!signerRef || typeof signerRef !== "object") return false;
        if (String(signerRef.alg || "") !== alg) return false;
        if (String(signerRef.keyId || "") !== keyId) return false;
        if (String(signerRef.accountId || "") !== accountId) return false;
        return nodeVerify(null, bytes, publicKeyObj, sigBytes);
      },
    },
  };
}

function makeAuthorityProvider(accounts) {
  const map = new Map();
  for (const acct of accounts) map.set(acct, createInviteAuthority(acct));
  return (accountId) => {
    const a = map.get(accountId);
    if (!a) throw new Error("missing authority for " + accountId);
    return a;
  };
}

function makePeerLinkService({ accountId, inboxId, getInviteAuthority }) {
  return new PeerLinkService({
    storageProvider: createDefaultStorageProvider(),
    clock: () => Date.now(),
    ownerAccountId: accountId,
    getInviteAuthority,
    inviteBinding: { mailboxId: inboxId, capabilityId: inboxId },
    cryptoProvider: new NodeCryptoProvider(),
  });
}

function makeFakeBus({ runtime } = {}) {
  const emits = [];
  return {
    runtime,
    services: {},
    stores: {},
    on() { return () => {}; },
    emit(name, payload) { emits.push({ name, payload }); },
    registerFunction() {},
    call() { return Promise.resolve(null); },
    emits,
  };
}

test("ServerPeerLinkProtocolService decrypts an inbound x3dh handshake and emits peerlink.protocol.snapshot", async () => {
  const aliceIdentity = createSessionIdentity();
  const bobIdentity = createSessionIdentity();
  const aliceAccountId = aliceIdentity.accountId;
  const bobAccountId = bobIdentity.accountId;
  const aliceInboxId = "inbox:alice";
  const bobInboxId = "inbox:bob";

  const getInviteAuthority = makeAuthorityProvider([aliceAccountId, bobAccountId]);
  const alicePeerLinks = makePeerLinkService({ accountId: aliceAccountId, inboxId: aliceInboxId, getInviteAuthority });
  const bobPeerLinks = makePeerLinkService({ accountId: bobAccountId, inboxId: bobInboxId, getInviteAuthority });

  await provisionPeerLinkBinding({ peerLinks: alicePeerLinks, identity: aliceIdentity });
  await provisionPeerLinkBinding({ peerLinks: bobPeerLinks, identity: bobIdentity });

  // Alice issues an invite, Bob accepts it locally — peerLinks.acceptInvite
  // synthesises the X3DH handshake packet Bob would normally deposit into
  // Alice's mailbox.
  const created = await alicePeerLinks.createInvite({
    ownerAccountId: aliceAccountId,
    maxUses: 1,
    expiresAtMs: Date.now() + 60_000,
  });
  const envelope = await alicePeerLinks.getStoredInviteEnvelope(aliceAccountId, created.inviteId);

  let capturedHandshakePacket = null;
  await bobPeerLinks.acceptInvite({
    envelope: envelope.envelope,
    signatureB64: envelope.signatureB64,
    acceptorAccountId: bobAccountId,
    senderInboxId: bobInboxId,
    sendHandshake: async ({ handshakePacket }) => {
      capturedHandshakePacket = handshakePacket;
      return { packetId: "test:packet:1" };
    },
  });
  assert.ok(capturedHandshakePacket, "Bob's acceptInvite produced a handshake packet");

  // The deposit body is the handshake packet bytes, base64-encoded; that
  // matches what the SDK ships across the wire via mailbox.deposit.
  const ciphertextB64 = Buffer.from(capturedHandshakePacket.toBytes()).toString("base64");

  const deposits = [];
  const fakeSdk = {
    mailbox: {
      deposit: async (opts) => {
        deposits.push(opts);
        return { eventId: "evt:deposit:" + deposits.length };
      },
    },
    getIdentity: () => ({ localInboxId: aliceInboxId }),
  };
  const bus = makeFakeBus({ runtime: { peerLinks: alicePeerLinks, sdk: fakeSdk } });
  const protocolService = new ServerPeerLinkProtocolService({
    bus,
    ownerAccountId: aliceAccountId,
    logger: { log() {}, info() {}, warn() {}, error() {} },
  });

  await protocolService._handleMailboxDeposited({
    body: {
      eventId: "evt:1",
      mailboxId: aliceInboxId,
      ciphertextB64,
    },
  });

  const snapshotEmit = bus.emits.find((e) => e.name === "peerlink.protocol.snapshot");
  assert.ok(snapshotEmit, "expected peerlink.protocol.snapshot emit");
  assert.equal(snapshotEmit.payload.peerAccountId, bobAccountId);
  assert.equal(snapshotEmit.payload.peerInboxId, bobInboxId);

  // Alice's PeerLinkService now stores the peer-link record.
  const links = await alicePeerLinks.peerLinkStorage.peerLinks.listByOwner(aliceAccountId);
  assert.equal(links.length, 1);
  assert.equal(links[0].peerAccountId, bobAccountId);

  // Verify the handshake.ack was deposited back to Bob's inbox in the
  // signed v2 envelope shape so Bob's chat-server can move from
  // "handshake_sent" to "session_established" only when the signature
  // verifies against the inviter's persisted X3DH identity pubkey.
  assert.equal(deposits.length, 1, "expected one handshake.ack deposit");
  assert.equal(deposits[0].mailboxId, bobInboxId);
  const ackBody = JSON.parse(new TextDecoder().decode(Buffer.from(deposits[0].ciphertextB64, "base64")));
  assert.equal(ackBody.kind, "rez.peerlink.handshake.ack.v2");
  assert.ok(ackBody.ack, "v2 ack carries a structured `ack` payload");
  assert.equal(ackBody.ack.senderAccountId, aliceAccountId);
  assert.equal(ackBody.ack.senderInboxId, aliceInboxId);
  assert.equal(typeof ackBody.ack.senderIdentitySigningPubKeyB64, "string");
  assert.ok(ackBody.ack.senderIdentitySigningPubKeyB64.length > 0);
  assert.equal(typeof ackBody.signatureB64, "string");
  assert.ok(ackBody.signatureB64.length > 0);
});

test("MED-1: handshake-ack with forged signature is rejected and does NOT advance state", async () => {
  // Reverse direction of the smoke test: Alice (inviter) sends a real
  // handshake-ack to Bob (acceptor). We tamper with the ack envelope
  // and confirm Bob refuses to transition past "handshake_sent".
  const aliceIdentity = createSessionIdentity();
  const bobIdentity = createSessionIdentity();
  const aliceAccountId = aliceIdentity.accountId;
  const bobAccountId = bobIdentity.accountId;
  const aliceInboxId = "inbox:alice-med1";
  const bobInboxId = "inbox:bob-med1";

  const getInviteAuthority = makeAuthorityProvider([aliceAccountId, bobAccountId]);
  const alicePeerLinks = makePeerLinkService({ accountId: aliceAccountId, inboxId: aliceInboxId, getInviteAuthority });
  const bobPeerLinks = makePeerLinkService({ accountId: bobAccountId, inboxId: bobInboxId, getInviteAuthority });

  await provisionPeerLinkBinding({ peerLinks: alicePeerLinks, identity: aliceIdentity });
  await provisionPeerLinkBinding({ peerLinks: bobPeerLinks, identity: bobIdentity });

  const created = await alicePeerLinks.createInvite({
    ownerAccountId: aliceAccountId,
    maxUses: 1,
    expiresAtMs: Date.now() + 60_000,
  });
  const envelope = await alicePeerLinks.getStoredInviteEnvelope(aliceAccountId, created.inviteId);

  let capturedHandshakePacket = null;
  await bobPeerLinks.acceptInvite({
    envelope: envelope.envelope,
    signatureB64: envelope.signatureB64,
    acceptorAccountId: bobAccountId,
    senderInboxId: bobInboxId,
    sendHandshake: async ({ handshakePacket }) => {
      capturedHandshakePacket = handshakePacket;
      return { packetId: "test:packet:med1" };
    },
  });
  assert.ok(capturedHandshakePacket);

  // Alice processes Bob's handshake packet to extract the ackNonce she
  // would normally echo back.
  const handled = await alicePeerLinks.handleIncomingHandshakePacket({
    ownerAccountId: aliceAccountId,
    packetBytes: capturedHandshakePacket.toBytes(),
  });
  assert.ok(handled && handled.ackNonce, "handler must surface ackNonce");

  // Build a forged ack: correct accountIds + correct ackNonce, but signed
  // by an attacker key (and embedded pubkey says it's the attacker).
  const attackerSig = CRYPTO.generateSigningKeyPair();
  const ackPayload = {
    senderIdentitySigningPubKeyB64: bytesToBase64(attackerSig.publicKey),
    senderAccountId: aliceAccountId,
    senderInboxId: aliceInboxId,
    senderDisplayName: "Alice (impostor)",
    ackNonce: handled.ackNonce,
    createdAtMs: Date.now(),
  };
  const forgedSig = CRYPTO.sign({
    privateKey: attackerSig.privateKey,
    msg: signedPayloadBytes(ackPayload),
  });
  const forgedAckJson = {
    kind: "rez.peerlink.handshake.ack.v2",
    ack: ackPayload,
    signatureB64: bytesToBase64(forgedSig),
  };
  const forgedAckBytes = new TextEncoder().encode(JSON.stringify(forgedAckJson));

  const result = await bobPeerLinks.handleIncomingHandshakeAck({
    ownerAccountId: bobAccountId,
    ackPacketBytes: forgedAckBytes,
  });
  // The forged ack must NOT advance state — handler returns null on any
  // pubkey-mismatch / signature-failure path.
  assert.equal(result, null, "forged ack must not advance the peer-link state");

  const bobLinks = await bobPeerLinks.peerLinkStorage.peerLinks.listByOwner(bobAccountId);
  assert.equal(bobLinks.length, 1);
  assert.notEqual(bobLinks[0].state, "session_established", "peer-link must NOT progress to session_established on forged ack");
});

// Regression for the "wiped data → fresh account re-uses same invite →
// silently detached" bug. The inviter's claimInviteAsRemote is the ONLY
// enforcement point for maxUses on cross-network accepts; a second claim
// of a single-use invite must surface INVITE_USED_UP, regardless of
// whether the second acceptor is the same identity or a brand-new one.
test("claimInviteAsRemote spends atomically: second claim of a single-use invite throws INVITE_USED_UP", async () => {
  const aliceIdentity = createSessionIdentity();
  const aliceAccountId = aliceIdentity.accountId;
  const aliceInboxId = "inbox:alice-spend";

  const getInviteAuthority = makeAuthorityProvider([aliceAccountId]);
  const alicePeerLinks = makePeerLinkService({ accountId: aliceAccountId, inboxId: aliceInboxId, getInviteAuthority });
  await provisionPeerLinkBinding({ peerLinks: alicePeerLinks, identity: aliceIdentity });

  const created = await alicePeerLinks.createInvite({
    ownerAccountId: aliceAccountId,
    maxUses: 1,
    expiresAtMs: Date.now() + 60_000,
  });

  // First claim succeeds and returns the envelope.
  const first = await alicePeerLinks.claimInviteAsRemote({
    ownerAccountId: aliceAccountId,
    inviteId: created.inviteId,
  });
  assert.ok(first && first.envelope, "first claim returns envelope");
  assert.equal(typeof first.signatureB64, "string");
  assert.ok(first.signatureB64.length > 0);

  // Second claim — what the friend's freshly created account did after
  // wiping data — MUST throw INVITE_USED_UP, not silently succeed.
  let secondErr = null;
  try {
    await alicePeerLinks.claimInviteAsRemote({
      ownerAccountId: aliceAccountId,
      inviteId: created.inviteId,
    });
  } catch (err) {
    secondErr = err;
  }
  assert.ok(secondErr, "second claim must throw");
  assert.equal(secondErr.code, "INVITE_USED_UP",
    "error.code must be INVITE_USED_UP so the inviter can surface it in claim.res");

  // Unknown inviteId returns INVITE_NOT_FOUND, not a silent null.
  let missingErr = null;
  try {
    await alicePeerLinks.claimInviteAsRemote({
      ownerAccountId: aliceAccountId,
      inviteId: "plinv_does_not_exist",
    });
  } catch (err) {
    missingErr = err;
  }
  assert.ok(missingErr, "unknown inviteId must throw");
  assert.equal(missingErr.code, "INVITE_NOT_FOUND");
});

test("claim.req for a used invite responds with INVITE_USED_UP in claim.res error field", async () => {
  // End-to-end wire-level regression: confirm the typed error from
  // claimInviteAsRemote flows out through ServerPeerLinkProtocolService and
  // back to the acceptor in the claim.res body.
  const aliceIdentity = createSessionIdentity();
  const aliceAccountId = aliceIdentity.accountId;
  const aliceInboxId = "inbox:alice-claimres";
  const acceptorInboxId = "inbox:acceptor-claimres";

  const getInviteAuthority = makeAuthorityProvider([aliceAccountId]);
  const alicePeerLinks = makePeerLinkService({ accountId: aliceAccountId, inboxId: aliceInboxId, getInviteAuthority });
  await provisionPeerLinkBinding({ peerLinks: alicePeerLinks, identity: aliceIdentity });

  const created = await alicePeerLinks.createInvite({
    ownerAccountId: aliceAccountId,
    maxUses: 1,
    expiresAtMs: Date.now() + 60_000,
  });
  // Burn the only use first so the claim.req that follows must be refused.
  await alicePeerLinks.claimInviteAsRemote({
    ownerAccountId: aliceAccountId,
    inviteId: created.inviteId,
  });

  const deposits = [];
  const fakeSdk = {
    mailbox: {
      deposit: async (opts) => {
        deposits.push(opts);
        return { eventId: "evt:claimres:" + deposits.length };
      },
    },
    getIdentity: () => ({ localInboxId: aliceInboxId }),
  };
  const bus = makeFakeBus({ runtime: { peerLinks: alicePeerLinks, sdk: fakeSdk } });
  const protocolService = new ServerPeerLinkProtocolService({
    bus,
    ownerAccountId: aliceAccountId,
    logger: { log() {}, info() {}, warn() {}, error() {} },
  });

  await protocolService._handleInboundClaimRequest({
    kind: "rez.peerlink.claim.req",
    inviteId: created.inviteId,
    replyInboxId: acceptorInboxId,
    requestId: "req_used_up",
  });

  assert.equal(deposits.length, 1, "claim.res deposited back to acceptor inbox");
  assert.equal(deposits[0].mailboxId, acceptorInboxId);
  const body = JSON.parse(new TextDecoder().decode(Buffer.from(deposits[0].ciphertextB64, "base64")));
  assert.equal(body.kind, "rez.peerlink.claim.res");
  assert.equal(body.requestId, "req_used_up");
  assert.equal(body.envelope, null, "envelope must NOT be returned for a refused claim");
  assert.equal(body.signatureB64, null);
  assert.ok(body.error, "claim.res carries error object");
  assert.equal(body.error.code, "INVITE_USED_UP");
});
