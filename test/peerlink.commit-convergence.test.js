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

// Phase 2 consolidation coverage. After collapsing the seven establishment
// paths onto one #commitSession writer + one state machine, these tests drive
// the real establishment flows end-to-end and assert (a) every path converges
// on session_established with an "active" session and a single lifecycle event
// (the #commitSession signature), and (b) the recipient-side THREAD_NOT_READY
// recovery attribution increments per-link miss counters and flips
// rehandshakeNeeded at the threshold, clearing on a successful decrypt.

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
      getSignerRef() { return { accountId, keyId, alg }; },
      async sign(bytes) { return new Uint8Array(nodeSign(null, bytes, privateKeyObj)); },
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

// Drive a full bidirectional establishment between two freshly-provisioned
// services. Returns the captured per-step results so tests can assert each
// path's snapshot/event independently.
async function establishPair({ inviter, inviterId, invitee, inviteeId, inviterInbox, inviteeInbox }) {
  const created = await inviter.createInvite({ ownerAccountId: inviterId, maxUses: 1, expiresAtMs: Date.now() + 60_000 });
  const envelope = await inviter.getStoredInviteEnvelope(inviterId, created.inviteId);

  let handshakePacket = null;
  const accept = await invitee.acceptInvite({
    envelope: envelope.envelope,
    signatureB64: envelope.signatureB64,
    acceptorAccountId: inviteeId,
    senderInboxId: inviteeInbox,
    sendHandshake: async ({ handshakePacket: hp }) => {
      handshakePacket = hp;
      return { packetId: "test:hs:1" };
    },
  });

  const received = await inviter.handleIncomingHandshakePacket({
    ownerAccountId: inviterId,
    packetBytes: handshakePacket.toBytes(),
  });

  const { ackBytes } = await inviter.createSignedHandshakeAck({
    ownerAccountId: inviterId,
    ownerInboxId: inviterInbox,
    ackNonce: received.ackNonce,
  });
  const acked = await invitee.handleIncomingHandshakeAck({
    ownerAccountId: inviteeId,
    ackPacketBytes: ackBytes,
  });

  return { accept, received, acked };
}

test("every establishment path converges on session_established via #commitSession", async () => {
  const alice = createSessionIdentity();
  const bob = createSessionIdentity();
  const getInviteAuthority = makeAuthorityProvider([alice.accountId, bob.accountId]);
  const alicePeerLinks = makePeerLinkService({ accountId: alice.accountId, inboxId: "inbox:alice", getInviteAuthority });
  const bobPeerLinks = makePeerLinkService({ accountId: bob.accountId, inboxId: "inbox:bob", getInviteAuthority });
  await provisionPeerLinkBinding({ peerLinks: alicePeerLinks, identity: alice });
  await provisionPeerLinkBinding({ peerLinks: bobPeerLinks, identity: bob });

  const { accept, received, acked } = await establishPair({
    inviter: alicePeerLinks, inviterId: alice.accountId, invitee: bobPeerLinks, inviteeId: bob.accountId,
    inviterInbox: "inbox:alice", inviteeInbox: "inbox:bob",
  });

  // acceptInvite (initiator, two-phase): the pre-send session-create routed
  // through #commitSession, then the send branch advanced to handshake_sent.
  assert.equal(accept.snapshot.state, "handshake_sent");
  assert.equal(accept.snapshot.sessionState, "pending_remote_confirm");

  // handleIncomingHandshakePacket (responder) → #establishAsResponder + #commitSession.
  assert.equal(received.snapshot.state, "session_established");
  assert.equal(received.snapshot.sessionState, "active");
  assert.equal(received.event.type, "handshake_received");
  assert.equal(received.event.details.sessionId, received.snapshot.activeSessionId);
  assert.equal(received.event.details.peerAccountId, bob.accountId);

  // handleIncomingHandshakeAck (initiator confirm) → #commitSession (status flip).
  assert.equal(acked.snapshot.state, "session_established");
  assert.equal(acked.snapshot.sessionState, "active");
  assert.equal(acked.event.type, "handshake_ack_received");

  // Steady-state decrypt must NOT emit a second establish event (no-op guard
  // preserved): the ratchet advances but no peer-link write happens.
  const plaintext = new TextEncoder().encode("hello alice");
  const enc = await bobPeerLinks.encryptDirectMessage({ ownerAccountId: bob.accountId, peerAccountId: alice.accountId, plaintextBytes: plaintext });
  const dec = await alicePeerLinks.decryptDirectMessageAnyPeer({ ownerAccountId: alice.accountId, packetBytes: enc.encryptedPacket.toBytes() });
  assert.equal(dec.event, null, "steady-state decrypt does not write peer-link state");
  assert.deepEqual(new TextDecoder().decode(dec.plaintextBytes), "hello alice");
});

test("rehandshake re-establishes through #commitSession with a fresh active session", async () => {
  const alice = createSessionIdentity();
  const bob = createSessionIdentity();
  const getInviteAuthority = makeAuthorityProvider([alice.accountId, bob.accountId]);
  const alicePeerLinks = makePeerLinkService({ accountId: alice.accountId, inboxId: "inbox:alice2", getInviteAuthority });
  const bobPeerLinks = makePeerLinkService({ accountId: bob.accountId, inboxId: "inbox:bob2", getInviteAuthority });
  await provisionPeerLinkBinding({ peerLinks: alicePeerLinks, identity: alice });
  await provisionPeerLinkBinding({ peerLinks: bobPeerLinks, identity: bob });
  await establishPair({
    inviter: alicePeerLinks, inviterId: alice.accountId, invitee: bobPeerLinks, inviteeId: bob.accountId,
    inviterInbox: "inbox:alice2", inviteeInbox: "inbox:bob2",
  });

  // Alice requests a rehandshake; Bob handles it (initiator) and replies with a
  // handshake packet; Alice processes the response (responder) — both writes go
  // through #commitSession and land in session_established with an active session.
  const req = await alicePeerLinks.requestRehandshake({ ownerAccountId: alice.accountId, peerAccountId: bob.accountId, senderInboxId: "inbox:alice2" });
  assert.equal(req.snapshot.state, "rehandshake_requested");

  const handled = await bobPeerLinks.handleIncomingRehandshake({
    ownerAccountId: bob.accountId,
    requestId: req.rehandshakeRecord.requestId,
    senderAccountId: alice.accountId,
    senderInboxId: "inbox:alice2",
    bundleJson: req.rehandshakeRecord.bundleJson,
  });
  assert.equal(handled.snapshot.state, "session_established");
  assert.equal(handled.snapshot.sessionState, "active");
  assert.equal(handled.event.type, "rehandshake_completed");

  const resp = await alicePeerLinks.handleRehandshakeResponse({
    ownerAccountId: alice.accountId,
    packetBytes: handled.handshakePacket.toBytes(),
  });
  assert.equal(resp.snapshot.state, "session_established");
  assert.equal(resp.snapshot.sessionState, "active");
  assert.equal(resp.event.type, "rehandshake_response_completed");

  // The re-established session must carry traffic.
  const enc = await bobPeerLinks.encryptDirectMessage({ ownerAccountId: bob.accountId, peerAccountId: alice.accountId, plaintextBytes: new TextEncoder().encode("after rehs") });
  const dec = await alicePeerLinks.decryptDirectMessageAnyPeer({ ownerAccountId: alice.accountId, packetBytes: enc.encryptedPacket.toBytes() });
  assert.deepEqual(new TextDecoder().decode(dec.plaintextBytes), "after rehs");
});

test("THREAD_NOT_READY attaches recoveryCandidates, increments per-link, flips at threshold, clears on success", async () => {
  const alice = createSessionIdentity();
  const bob = createSessionIdentity();
  const carol = createSessionIdentity();
  const getInviteAuthority = makeAuthorityProvider([alice.accountId, bob.accountId, carol.accountId]);
  const alicePeerLinks = makePeerLinkService({ accountId: alice.accountId, inboxId: "inbox:alice3", getInviteAuthority });
  const bobPeerLinks = makePeerLinkService({ accountId: bob.accountId, inboxId: "inbox:bob3", getInviteAuthority });
  const carolPeerLinks = makePeerLinkService({ accountId: carol.accountId, inboxId: "inbox:carol3", getInviteAuthority });
  await provisionPeerLinkBinding({ peerLinks: alicePeerLinks, identity: alice });
  await provisionPeerLinkBinding({ peerLinks: bobPeerLinks, identity: bob });
  await provisionPeerLinkBinding({ peerLinks: carolPeerLinks, identity: carol });

  // Alice and Bob fully establish — Alice now has a usable (active) session to Bob.
  await establishPair({
    inviter: alicePeerLinks, inviterId: alice.accountId, invitee: bobPeerLinks, inviteeId: bob.accountId,
    inviterInbox: "inbox:alice3", inviteeInbox: "inbox:bob3",
  });

  // Carol accepts a SEPARATE Alice invite (deriving a one-sided session to
  // Alice) but Alice never processes Carol's handshake — so Alice has no Carol
  // link. Carol's encrypted messages therefore never match Alice's only link
  // (Bob), producing a total miss with Bob as the usable-but-failed candidate.
  const created = await alicePeerLinks.createInvite({ ownerAccountId: alice.accountId, maxUses: 1, expiresAtMs: Date.now() + 60_000 });
  const env = await alicePeerLinks.getStoredInviteEnvelope(alice.accountId, created.inviteId);
  await carolPeerLinks.acceptInvite({
    envelope: env.envelope,
    signatureB64: env.signatureB64,
    acceptorAccountId: carol.accountId,
    senderInboxId: "inbox:carol3",
    sendHandshake: async () => ({ packetId: "ignored" }),
  });

  async function carolPacket(text) {
    const enc = await carolPeerLinks.encryptDirectMessage({ ownerAccountId: carol.accountId, peerAccountId: alice.accountId, plaintextBytes: new TextEncoder().encode(text) });
    return enc.encryptedPacket.toBytes();
  }

  async function missAndCapture(text) {
    try {
      await alicePeerLinks.decryptDirectMessageAnyPeer({ ownerAccountId: alice.accountId, packetBytes: await carolPacket(text) });
      throw new Error("expected THREAD_NOT_READY");
    } catch (err) {
      assert.equal(err.code, "THREAD_NOT_READY", "total miss throws THREAD_NOT_READY");
      return err;
    }
  }

  const e1 = await missAndCapture("m1");
  assert.equal(Array.isArray(e1.recoveryCandidates), true);
  assert.equal(e1.recoveryCandidates.length, 1, "Bob is the single usable-but-failed candidate");
  assert.equal(e1.recoveryCandidates[0].peerAccountId, bob.accountId);
  assert.equal(e1.recoveryCandidates[0].consecutiveMisses, 1);
  assert.equal(e1.recoveryCandidates[0].rehandshakeNeeded, false);

  const e2 = await missAndCapture("m2");
  assert.equal(e2.recoveryCandidates[0].consecutiveMisses, 2);
  assert.equal(e2.recoveryCandidates[0].rehandshakeNeeded, false);

  const e3 = await missAndCapture("m3");
  assert.equal(e3.recoveryCandidates[0].consecutiveMisses, 3);
  assert.equal(e3.recoveryCandidates[0].rehandshakeNeeded, true, "flips at threshold (3)");

  // A successful decrypt against the Bob session clears its miss counter.
  const bobEnc = await bobPeerLinks.encryptDirectMessage({ ownerAccountId: bob.accountId, peerAccountId: alice.accountId, plaintextBytes: new TextEncoder().encode("real") });
  const ok = await alicePeerLinks.decryptDirectMessageAnyPeer({ ownerAccountId: alice.accountId, packetBytes: bobEnc.encryptedPacket.toBytes() });
  assert.deepEqual(new TextDecoder().decode(ok.plaintextBytes), "real");

  const e4 = await missAndCapture("m4");
  assert.equal(e4.recoveryCandidates[0].consecutiveMisses, 1, "counter reset after a successful decrypt");
  assert.equal(e4.recoveryCandidates[0].rehandshakeNeeded, false);
});
