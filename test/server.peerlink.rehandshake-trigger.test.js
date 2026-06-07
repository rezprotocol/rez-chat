// Contract test for recipient-side re-handshake recovery (v0.4.6).
//
// The THREAD_NOT_READY / DECRYPT_FAILED recovery paths in
// ServerPeerLinkProtocolService call _triggerRehandshake, which must drive the
// REAL SDK PeerLinkService.requestRehandshake and dispatch the resulting signed
// request to the peer's inbox. A prior version called the SDK with a
// `sendRehandshake` callback and no `senderInboxId`; the SDK requires
// senderInboxId (requireId throws) and never invokes the callback, so recovery
// silently no-op'd. The existing recovery test only STUBBED requestRehandshake,
// so the drift went undetected. This test wires the REAL SDK end-to-end:
// establish Alice→Bob, trigger a re-handshake, and assert a real
// `x3dh.rehandshake.v1` request is dispatched to Bob's inbox and Alice's
// peer-link advances to rehandshake_requested. See memory
// project_offline_push_before_handshake_race.

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

// Establish Alice (inviter) → Bob so Alice holds an active peer-link to Bob with
// peerInboxId = Bob's inbox. Returns the live PeerLinkService for Alice.
async function establishInviterToAcceptor({ aliceIdentity, bobIdentity, aliceInboxId, bobInboxId, getInviteAuthority }) {
  const alicePeerLinks = makePeerLinkService({ accountId: aliceIdentity.accountId, inboxId: aliceInboxId, getInviteAuthority });
  const bobPeerLinks = makePeerLinkService({ accountId: bobIdentity.accountId, inboxId: bobInboxId, getInviteAuthority });
  await provisionPeerLinkBinding({ peerLinks: alicePeerLinks, identity: aliceIdentity });
  await provisionPeerLinkBinding({ peerLinks: bobPeerLinks, identity: bobIdentity });

  const created = await alicePeerLinks.createInvite({
    ownerAccountId: aliceIdentity.accountId,
    maxUses: 1,
    expiresAtMs: Date.now() + 60_000,
  });
  const envelope = await alicePeerLinks.getStoredInviteEnvelope(aliceIdentity.accountId, created.inviteId);

  let capturedHandshakePacket = null;
  await bobPeerLinks.acceptInvite({
    envelope: envelope.envelope,
    signatureB64: envelope.signatureB64,
    acceptorAccountId: bobIdentity.accountId,
    senderInboxId: bobInboxId,
    sendHandshake: async ({ handshakePacket }) => {
      capturedHandshakePacket = handshakePacket;
      return { packetId: "test:packet:1" };
    },
  });
  assert.ok(capturedHandshakePacket, "Bob's acceptInvite produced a handshake packet");

  // Alice processes Bob's handshake → Alice now has an active peer-link to Bob.
  await alicePeerLinks.handleIncomingHandshakePacket({
    ownerAccountId: aliceIdentity.accountId,
    packetBytes: capturedHandshakePacket.toBytes(),
  });
  return alicePeerLinks;
}

test("_triggerRehandshake drives the real SDK requestRehandshake and dispatches an x3dh.rehandshake.v1 request to the peer", async () => {
  const aliceIdentity = createSessionIdentity();
  const bobIdentity = createSessionIdentity();
  const aliceInboxId = "inbox:alice-rh";
  const bobInboxId = "inbox:bob-rh";
  const getInviteAuthority = makeAuthorityProvider([aliceIdentity.accountId, bobIdentity.accountId]);

  const alicePeerLinks = await establishInviterToAcceptor({
    aliceIdentity, bobIdentity, aliceInboxId, bobInboxId, getInviteAuthority,
  });

  // Capture mesh dispatch; resolve a deferred so the fire-and-forget trigger is
  // awaited deterministically (a contract break would never dispatch → timeout).
  const dispatched = [];
  let resolveDispatch;
  const dispatchedOnce = new Promise((res) => { resolveDispatch = res; });
  const fakeSdk = {
    mesh: {
      async dispatch(object, address) {
        dispatched.push({ object, address });
        resolveDispatch();
      },
    },
    getIdentity: () => ({ localInboxId: aliceInboxId }),
  };
  const bus = makeFakeBus({ runtime: { peerLinks: alicePeerLinks, sdk: fakeSdk } });
  const protocolService = new ServerPeerLinkProtocolService({
    bus,
    ownerAccountId: aliceIdentity.accountId,
    logger: { log() {}, info() {}, warn() {}, error() {} },
  });

  // The production entry point — fire-and-forget. No stub: this exercises the
  // real PeerLinkService.requestRehandshake contract.
  protocolService._triggerRehandshake({ peerAccountId: bobIdentity.accountId });
  await dispatchedOnce;

  assert.equal(dispatched.length, 1, "exactly one re-handshake request dispatched");
  const wire = JSON.parse(new TextDecoder().decode(dispatched[0].object.payloadBytes));
  assert.equal(wire.e2ee, 1);
  assert.equal(wire.type, "x3dh.rehandshake.v1", "dispatched the re-handshake REQUEST wire type");
  assert.ok(wire.rehandshake && typeof wire.rehandshake === "object", "carries a rehandshake body");
  assert.equal(wire.rehandshake.senderAccountId, aliceIdentity.accountId, "request is from Alice");
  assert.equal(wire.rehandshake.senderInboxId, aliceInboxId, "request carries Alice's reply inbox (senderInboxId)");
  assert.ok(typeof wire.rehandshake.requestId === "string" && wire.rehandshake.requestId.length > 0, "has a requestId");
  assert.ok(wire.rehandshake.bundleJson && typeof wire.rehandshake.bundleJson === "object", "carries a fresh pre-key bundle");

  // Alice's peer-link advanced to rehandshake_requested (the SDK state write).
  const links = await alicePeerLinks.listPeerLinks({ ownerAccountId: aliceIdentity.accountId });
  const bobLink = links.items.find((it) => it.peerAccountId === bobIdentity.accountId);
  assert.ok(bobLink, "Alice still holds a peer-link to Bob");
  assert.equal(bobLink.state, "rehandshake_requested", "peer-link advanced to rehandshake_requested");
});

test("_triggerRehandshake is a safe no-op when the peer has no resolvable inbox", async () => {
  const aliceIdentity = createSessionIdentity();
  const getInviteAuthority = makeAuthorityProvider([aliceIdentity.accountId]);
  const alicePeerLinks = makePeerLinkService({ accountId: aliceIdentity.accountId, inboxId: "inbox:alice-solo", getInviteAuthority });
  await provisionPeerLinkBinding({ peerLinks: alicePeerLinks, identity: aliceIdentity });

  const dispatched = [];
  const fakeSdk = {
    mesh: { async dispatch(object, address) { dispatched.push({ object, address }); } },
    getIdentity: () => ({ localInboxId: "inbox:alice-solo" }),
  };
  const bus = makeFakeBus({ runtime: { peerLinks: alicePeerLinks, sdk: fakeSdk } });
  const protocolService = new ServerPeerLinkProtocolService({
    bus,
    ownerAccountId: aliceIdentity.accountId,
    logger: { log() {}, info() {}, warn() {}, error() {} },
  });

  // No peer-link for this account → no inbox → nothing dispatched, no throw.
  await protocolService._sendRehandshakeRequest({
    peerLinks: alicePeerLinks,
    sdk: fakeSdk,
    remote: "rez:acct:nobody",
    senderInboxId: "inbox:alice-solo",
  });
  assert.equal(dispatched.length, 0, "no request dispatched for an unknown peer");
});
