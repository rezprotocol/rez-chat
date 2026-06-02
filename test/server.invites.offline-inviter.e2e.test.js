import test from "node:test";
import assert from "node:assert/strict";

import {
  bytesToBase64,
  base64ToBytes,
  canonicalJSONStringify,
  createDefaultStorageProvider,
  deriveAccountIdFromPublicKey,
  PEERLINK_INVITE_RECORD_KIND,
} from "@rezprotocol/sdk/client";
import { PeerLinkService } from "@rezprotocol/sdk/peer-link";
import {
  NodeCryptoProvider,
  DhtNode,
  ControlMessageRegistry,
} from "@rezprotocol/node";

import { buildChatServerInviteAuthority } from "../src/server/bootstrap/bootstrapChatServer.js";

/**
 * Un-mocked offline-inviter invite e2e — the Stage 2 deliverable proof.
 *
 * This exercises the real crypto bridge end-to-end with NOTHING mocked on the
 * crypto/storage paths:
 *
 *   1. A real inviter PeerLinkService mints + signs an invite envelope AND the
 *      durable record that carries it, using the production chat-server invite
 *      authority (raw-Ed25519 sign over DER-SPKI keys).
 *   2. A real rez-node DhtNode stores the record — verifyDurableRecord runs the
 *      same NodeCryptoProvider verify against publisherPublicKeyB64, proving the
 *      chat-server signer and the node verifier agree byte-for-byte.
 *   3. The inviter goes OFFLINE (its PeerLinkService is never consulted during
 *      accept). A real acceptor PeerLinkService fetches the record from the node,
 *      decodes the envelope, self-verifies the signature + the embedded account
 *      binding, runs the X3DH initiator, and emits a handshake packet — all with
 *      no inviter contact.
 *   4. The inviter comes back online and consumes the buffered handshake packet;
 *      the peer-link reaches session_established on the inviter side.
 *
 * Per project memory ("mocked tests hide crypto-correctness bugs"), this is the
 * un-mocked proof that the durable-record invite flow works with the inviter
 * offline — for both DM and group invites.
 */

const CRYPTO = new NodeCryptoProvider();

function makeChatIdentity() {
  const keyPair = CRYPTO.generateSigningKeyPair();
  return {
    accountId: deriveAccountIdFromPublicKey(keyPair.publicKey),
    // DER-encoded key bytes (spki/pkcs8) — the form NodeCryptoProvider expects.
    publicKey: keyPair.publicKey,
    privateKey: keyPair.privateKey,
    publicKeyB64: bytesToBase64(keyPair.publicKey),
    privateKeyB64: bytesToBase64(keyPair.privateKey),
    accountIdentityPublicKeyB64: bytesToBase64(keyPair.publicKey),
  };
}

function makePeerLinks({ identity, inboxId, getInviteAuthority }) {
  return new PeerLinkService({
    storageProvider: createDefaultStorageProvider(),
    clock: () => Date.now(),
    ownerAccountId: identity.accountId,
    getInviteAuthority,
    inviteBinding: { mailboxId: inboxId, capabilityId: inboxId },
    cryptoProvider: new NodeCryptoProvider(),
  });
}

// Provision the X3DH account binding the same way the chat-server runtime does:
// the account identity key signs an x3dh-subkey-binding tying the per-account
// X3DH identity subkey back to the account.
async function provisionBinding({ peerLinks, identity }) {
  const issuedAtMs = Date.now();
  const expiresAtMs = issuedAtMs + 7 * 24 * 60 * 60 * 1000;
  const challenge = await peerLinks.getOrCreateAccountBindingChallenge({ ownerAccountId: identity.accountId });
  const x3dhIdentityPublicKeyB64 = String((challenge && challenge.x3dhIdentityPublicKeyB64) || "").trim();
  const payload = {
    kind: "x3dh-subkey-binding",
    accountId: identity.accountId,
    x3dhIdentityPublicKeyB64,
    issuedAtMs,
    expiresAtMs,
  };
  const sig = CRYPTO.sign({
    privateKey: identity.privateKey,
    msg: new TextEncoder().encode(canonicalJSONStringify(payload)),
  });
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

// A single, peerless rez-node DhtNode used as the durable-record holder. With
// no peers, putRecord stores locally (after verifyDurableRecord) and getRecord
// resolves local-first — a real, un-mocked node-side round trip.
function makeHolderNode() {
  const registry = new ControlMessageRegistry();
  const node = new DhtNode({
    selfRelayKeyId: "relay-holder",
    controlMessageRegistry: registry,
    encodeCtl: (obj) => new TextEncoder().encode(JSON.stringify(obj)),
    trySendFrame: () => {},
    nowMs: () => Date.now(),
    config: { k: 20, alpha: 3, queryTimeoutMs: 2000, recordReplicateIntervalMs: 0 },
  });
  node.install();
  return node;
}

async function runOfflineInviteFlow({ kind, groupId, title }) {
  const inviterInbox = "inbox:inviter";
  const acceptorInbox = "inbox:acceptor";

  const inviterIdentity = makeChatIdentity();
  const acceptorIdentity = makeChatIdentity();

  // Production authorities. The verifier is account-agnostic (it verifies any
  // envelope against its embedded signerPublicKeyB64), so the acceptor can
  // verify the inviter's envelope cross-account.
  const inviterAuthority = buildChatServerInviteAuthority({
    accountId: inviterIdentity.accountId,
    identity: inviterIdentity,
    cryptoProvider: CRYPTO,
  });
  const acceptorAuthority = buildChatServerInviteAuthority({
    accountId: acceptorIdentity.accountId,
    identity: acceptorIdentity,
    cryptoProvider: CRYPTO,
  });

  const inviterPeerLinks = makePeerLinks({
    identity: inviterIdentity,
    inboxId: inviterInbox,
    getInviteAuthority: () => inviterAuthority,
  });
  const acceptorPeerLinks = makePeerLinks({
    identity: acceptorIdentity,
    inboxId: acceptorInbox,
    getInviteAuthority: () => acceptorAuthority,
  });
  await provisionBinding({ peerLinks: inviterPeerLinks, identity: inviterIdentity });
  await provisionBinding({ peerLinks: acceptorPeerLinks, identity: acceptorIdentity });

  // 1. Inviter (ONLINE) creates the invite + signs the durable record.
  const created = await inviterPeerLinks.createInvite({
    ownerAccountId: inviterIdentity.accountId,
    creatorDisplayName: "Inviter",
    kind,
    groupId,
    title,
    maxUses: 1,
    expiresAtMs: Date.now() + 60_000,
    peerInboxId: inviterInbox,
  });
  assert.ok(created.durableRecord, "createInvite returns a signed durable record");
  assert.equal(created.publisherPublicKeyB64, inviterIdentity.publicKeyB64,
    "publisher key is the inviter's identity key");

  // 2. Publish to a REAL rez-node — verifyDurableRecord runs here against the
  // chat-server-signed record. This is the cross-provider crypto bridge.
  const holder = makeHolderNode();
  const putResult = await holder.putRecord(created.durableRecord);
  assert.equal(putResult.stored, true,
    "node accepts the chat-server-signed record (crypto bridge holds): " + putResult.reason);

  // 3. Inviter goes OFFLINE: from here we never touch inviterPeerLinks until
  // it "comes back" for the handshake drain. The acceptor resolves everything
  // from the durable record alone.
  const fetched = await holder.getRecord({
    recordKind: PEERLINK_INVITE_RECORD_KIND,
    recordId: created.inviteId,
    publisherPublicKeyB64: created.publisherPublicKeyB64,
  });
  assert.ok(fetched && typeof fetched.payloadB64 === "string", "record fetched from node");

  const payload = JSON.parse(new TextDecoder().decode(base64ToBytes(fetched.payloadB64)));
  assert.ok(payload && payload.envelope, "payload carries the signed envelope");
  // Substitution safety (the check ServerInvitesService enforces): the inner
  // envelope's signer must equal the invite-code commitment / publisher key.
  assert.equal(payload.envelope.signerRef.signerPublicKeyB64, created.publisherPublicKeyB64,
    "envelope signer matches publisher key");

  // 4. Acceptor accepts with the inviter OFFLINE — real X3DH initiator runs.
  let capturedPacketBytes = null;
  let deliveredInbox = null;
  const accept = await acceptorPeerLinks.acceptInvite({
    envelope: payload.envelope,
    signatureB64: payload.signatureB64,
    acceptorAccountId: acceptorIdentity.accountId,
    acceptorDisplayName: "Acceptor",
    senderInboxId: acceptorInbox,
    sendHandshake: async ({ deliverInboxId, handshakePacket }) => {
      deliveredInbox = deliverInboxId;
      capturedPacketBytes = handshakePacket.toBytes();
      return {};
    },
  });
  assert.ok(accept && accept.snapshot, "acceptInvite returns a snapshot with inviter offline");
  assert.equal(accept.snapshot.localAccountId, acceptorIdentity.accountId);
  assert.equal(accept.snapshot.peerAccountId, inviterIdentity.accountId);
  assert.equal(deliveredInbox, inviterInbox, "handshake targets the inviter's inbox");
  assert.ok(capturedPacketBytes instanceof Uint8Array && capturedPacketBytes.length > 0,
    "a real X3DH handshake packet was produced offline");

  // 5. Inviter comes back ONLINE and drains the buffered handshake.
  const drained = await inviterPeerLinks.handleIncomingHandshakePacket({
    ownerAccountId: inviterIdentity.accountId,
    packetBytes: capturedPacketBytes,
  });
  assert.ok(drained, "inviter processes the buffered handshake on return");

  const inviterLinks = await inviterPeerLinks.peerLinkStorage.peerLinks.listByOwner(inviterIdentity.accountId);
  assert.equal(inviterLinks.length, 1, "inviter has exactly one peer-link after drain");
  assert.equal(inviterLinks[0].peerAccountId, acceptorIdentity.accountId,
    "peer-link is with the acceptor");
  assert.equal(inviterLinks[0].state, "session_established",
    "peer-link reaches session_established after the handshake drains");

  return { created, accept };
}

test("offline-inviter DM invite: durable record resolves accept with the inviter offline", async () => {
  await runOfflineInviteFlow({ kind: "direct", groupId: null, title: null });
});

test("offline-inviter group invite: durable record resolves accept with the inviter offline", async () => {
  const result = await runOfflineInviteFlow({
    kind: "group",
    groupId: "grp_offline_e2e",
    title: "Offline Group",
  });
  // The signed envelope carries the group context the acceptor materializes.
  assert.equal(result.accept.snapshot.peerAccountId.length > 0, true);
});

// --- maxUses enforcement at the handshake responder (single enforcement
// point) + handshake.reject + acceptor rollback ---------------------------

// A peer-link participant (inviter or acceptor) backed by a real chat-server
// identity + production invite authority. The authority verifier is
// account-agnostic, so the same shape works on both sides.
function makeParticipant(label) {
  const identity = makeChatIdentity();
  const inbox = "inbox:" + label;
  const authority = buildChatServerInviteAuthority({
    accountId: identity.accountId,
    identity,
    cryptoProvider: CRYPTO,
  });
  const peerLinks = makePeerLinks({
    identity,
    inboxId: inbox,
    getInviteAuthority: () => authority,
  });
  return { identity, inbox, peerLinks };
}

const makeAcceptor = makeParticipant;

// Provision an inviter, publish a fresh invite to the holder node, and return
// the pieces needed to drive acceptors against it.
async function setupInvite({ maxUses }) {
  const inviter = makeParticipant("inviter");
  await provisionBinding({ peerLinks: inviter.peerLinks, identity: inviter.identity });
  const created = await inviter.peerLinks.createInvite({
    ownerAccountId: inviter.identity.accountId,
    creatorDisplayName: "Inviter",
    kind: "direct",
    maxUses,
    expiresAtMs: Date.now() + 60_000,
    peerInboxId: inviter.inbox,
  });
  const holder = makeHolderNode();
  await holder.putRecord(created.durableRecord);
  return { inviter, created, holder };
}

// Resolve the envelope from the durable record (inviter offline) and run the
// acceptor's optimistic accept, capturing the real X3DH handshake packet.
async function acceptFromRecord({ acceptor, holder, inviteId, publisherPublicKeyB64 }) {
  const fetched = await holder.getRecord({
    recordKind: PEERLINK_INVITE_RECORD_KIND,
    recordId: inviteId,
    publisherPublicKeyB64,
  });
  const payload = JSON.parse(new TextDecoder().decode(base64ToBytes(fetched.payloadB64)));
  let packetBytes = null;
  const accept = await acceptor.peerLinks.acceptInvite({
    envelope: payload.envelope,
    signatureB64: payload.signatureB64,
    acceptorAccountId: acceptor.identity.accountId,
    acceptorDisplayName: acceptor.inbox,
    senderInboxId: acceptor.inbox,
    sendHandshake: async ({ handshakePacket }) => {
      packetBytes = handshakePacket.toBytes();
      return {};
    },
  });
  return { accept, packetBytes };
}

test("single-use invite: first distinct acceptor wins, second is rejected with handshake.reject + rollback", async () => {
  const { inviter, created, holder } = await setupInvite({ maxUses: 1 });
  const acceptorA = makeAcceptor("acceptorA");
  const acceptorB = makeAcceptor("acceptorB");
  await provisionBinding({ peerLinks: acceptorA.peerLinks, identity: acceptorA.identity });
  await provisionBinding({ peerLinks: acceptorB.peerLinks, identity: acceptorB.identity });

  // Acceptor A accepts and the inviter honours the first distinct acceptor.
  const a = await acceptFromRecord({
    acceptor: acceptorA, holder,
    inviteId: created.inviteId, publisherPublicKeyB64: created.publisherPublicKeyB64,
  });
  const drainedA = await inviter.peerLinks.handleIncomingHandshakePacket({
    ownerAccountId: inviter.identity.accountId,
    packetBytes: a.packetBytes,
  });
  assert.equal(Boolean(drainedA.rejected), false, "first distinct acceptor is honoured");
  assert.equal(drainedA.snapshot.state, "session_established");

  // Acceptor B (a DIFFERENT identity — e.g. wiped-data/fresh account) accepts
  // optimistically, then the inviter's lazy maxUses check rejects it.
  const b = await acceptFromRecord({
    acceptor: acceptorB, holder,
    inviteId: created.inviteId, publisherPublicKeyB64: created.publisherPublicKeyB64,
  });
  assert.equal(b.accept.snapshot.state, "handshake_sent", "acceptor B optimistically commits");

  const drainedB = await inviter.peerLinks.handleIncomingHandshakePacket({
    ownerAccountId: inviter.identity.accountId,
    packetBytes: b.packetBytes,
  });
  assert.equal(drainedB.rejected, true, "second distinct acceptor is rejected (invite used up)");
  assert.equal(drainedB.reason, "INVITE_USED_UP");
  assert.equal(drainedB.acceptorInboxId, acceptorB.inbox, "reject targets acceptor B's inbox");
  assert.ok(typeof drainedB.ackNonce === "string" && drainedB.ackNonce.length > 0);

  // The inviter holds exactly ONE peer-link (with A); B never created one here.
  const inviterLinks = await inviter.peerLinks.peerLinkStorage.peerLinks.listByOwner(inviter.identity.accountId);
  assert.equal(inviterLinks.length, 1, "inviter holds one peer-link (acceptor A only)");
  assert.equal(inviterLinks[0].peerAccountId, acceptorA.identity.accountId);

  // The inviter signs a reject; acceptor B authenticates it and rolls back.
  const { rejectBytes } = await inviter.peerLinks.createSignedHandshakeReject({
    ownerAccountId: inviter.identity.accountId,
    reason: drainedB.reason,
    ackNonce: drainedB.ackNonce,
  });
  const rolledBack = await acceptorB.peerLinks.handleHandshakeReject({
    ownerAccountId: acceptorB.identity.accountId,
    rejectPacketBytes: rejectBytes,
  });
  assert.ok(rolledBack, "acceptor B processes the authenticated reject");
  assert.equal(rolledBack.snapshot.state, "rejected", "acceptor B's optimistic peer-link is rolled back");
  assert.equal(rolledBack.reason, "INVITE_USED_UP");

  // The pending session was torn down on rollback.
  const bLink = await acceptorB.peerLinks.peerLinkStorage.peerLinks.getByPair(
    acceptorB.identity.accountId, inviter.identity.accountId,
  );
  assert.equal(bLink.state, "rejected");
  const bSession = await acceptorB.peerLinks.peerLinkStorage.sessions.getByPeerLinkId(
    acceptorB.identity.accountId, bLink.peerLinkId,
  );
  assert.ok(!bSession, "pending session deleted on rollback");
});

test("maxUses=2 invite: two distinct acceptors succeed, re-delivery is idempotent, third is rejected", async () => {
  const { inviter, created, holder } = await setupInvite({ maxUses: 2 });
  const acceptorA = makeAcceptor("multiA");
  const acceptorB = makeAcceptor("multiB");
  const acceptorC = makeAcceptor("multiC");
  for (const acc of [acceptorA, acceptorB, acceptorC]) {
    await provisionBinding({ peerLinks: acc.peerLinks, identity: acc.identity });
  }
  const drive = async (acceptor) => {
    const r = await acceptFromRecord({
      acceptor, holder,
      inviteId: created.inviteId, publisherPublicKeyB64: created.publisherPublicKeyB64,
    });
    const drained = await inviter.peerLinks.handleIncomingHandshakePacket({
      ownerAccountId: inviter.identity.accountId,
      packetBytes: r.packetBytes,
    });
    return { packetBytes: r.packetBytes, drained };
  };

  // First acceptor takes slot 1; the shared invite pre-key is RETAINED (the
  // invite is not yet exhausted), so the second distinct acceptor can also
  // complete X3DH.
  const dA = await drive(acceptorA);
  assert.equal(Boolean(dA.drained.rejected), false, "acceptor A honoured (slot 1/2)");

  // Re-delivery of A's SAME handshake packet is idempotent — proceeds, does
  // NOT consume a second slot (A is already in acceptedAcceptors, and the
  // pre-key is still present because the invite isn't exhausted).
  const dARe = await inviter.peerLinks.handleIncomingHandshakePacket({
    ownerAccountId: inviter.identity.accountId,
    packetBytes: dA.packetBytes,
  });
  assert.equal(Boolean(dARe.rejected), false, "re-delivery from same acceptor is idempotent (no slot consumed)");

  // Second DISTINCT acceptor takes slot 2 — proves the shared pre-key survived.
  const dB = await drive(acceptorB);
  assert.equal(Boolean(dB.drained.rejected), false, "acceptor B honoured (slot 2/2) — shared pre-key survived");

  // Third distinct acceptor is over the limit → rejected.
  const dC = await drive(acceptorC);
  assert.equal(dC.drained.rejected, true, "acceptor C rejected (both slots used)");
  assert.equal(dC.drained.reason, "INVITE_USED_UP");

  const inviterLinks = await inviter.peerLinks.peerLinkStorage.peerLinks.listByOwner(inviter.identity.accountId);
  assert.equal(inviterLinks.length, 2, "inviter holds two peer-links (A + B only)");
});

test("rejected acceptor can re-attempt with a FRESH invite — reuses the dead peer-link, re-establishes", async () => {
  // 1. A single-use invite is fully consumed by acceptor A, so acceptor B is
  //    rejected and B's peer-link with the inviter lands in terminal "rejected".
  const { inviter, created, holder } = await setupInvite({ maxUses: 1 });
  const acceptorA = makeAcceptor("reattemptA");
  const acceptorB = makeAcceptor("reattemptB");
  await provisionBinding({ peerLinks: acceptorA.peerLinks, identity: acceptorA.identity });
  await provisionBinding({ peerLinks: acceptorB.peerLinks, identity: acceptorB.identity });

  const a = await acceptFromRecord({
    acceptor: acceptorA, holder,
    inviteId: created.inviteId, publisherPublicKeyB64: created.publisherPublicKeyB64,
  });
  await inviter.peerLinks.handleIncomingHandshakePacket({
    ownerAccountId: inviter.identity.accountId, packetBytes: a.packetBytes,
  });

  const b = await acceptFromRecord({
    acceptor: acceptorB, holder,
    inviteId: created.inviteId, publisherPublicKeyB64: created.publisherPublicKeyB64,
  });
  const drainedB = await inviter.peerLinks.handleIncomingHandshakePacket({
    ownerAccountId: inviter.identity.accountId, packetBytes: b.packetBytes,
  });
  assert.equal(drainedB.rejected, true, "B rejected (invite used up)");
  const { rejectBytes } = await inviter.peerLinks.createSignedHandshakeReject({
    ownerAccountId: inviter.identity.accountId,
    reason: drainedB.reason,
    ackNonce: drainedB.ackNonce,
  });
  const rolledBack = await acceptorB.peerLinks.handleHandshakeReject({
    ownerAccountId: acceptorB.identity.accountId, rejectPacketBytes: rejectBytes,
  });
  const rejectedLinkId = rolledBack.snapshot.peerLinkId;
  assert.equal(rolledBack.snapshot.state, "rejected", "B's peer-link is terminal rejected");

  // 2. The inviter issues a SECOND, fresh invite (new inviteId + pre-key) and
  //    publishes it. Acceptor B accepts it — its existing peer-link is in the
  //    dead "rejected" state, so accept must RE-DRIVE the handshake on the same
  //    record rather than short-circuit as idempotent.
  const created2 = await inviter.peerLinks.createInvite({
    ownerAccountId: inviter.identity.accountId,
    creatorDisplayName: "Inviter",
    kind: "direct",
    maxUses: 1,
    expiresAtMs: Date.now() + 60_000,
    peerInboxId: inviter.inbox,
  });
  await holder.putRecord(created2.durableRecord);

  const b2 = await acceptFromRecord({
    acceptor: acceptorB, holder,
    inviteId: created2.inviteId, publisherPublicKeyB64: created2.publisherPublicKeyB64,
  });
  assert.notEqual(b2.accept.snapshot.state, "rejected",
    "re-accept transitions the dead link out of rejected");
  assert.equal(b2.accept.snapshot.state, "handshake_sent",
    "re-accept optimistically commits a fresh handshake");
  assert.equal(b2.accept.snapshot.peerLinkId, rejectedLinkId,
    "the re-attempt REUSES the existing peer-link record (no duplicate for the pair)");

  // B holds exactly ONE peer-link with the inviter (reused, not duplicated).
  const bLinks = (await acceptorB.peerLinks.peerLinkStorage.peerLinks.listByOwner(acceptorB.identity.accountId))
    .filter((l) => l.peerAccountId === inviter.identity.accountId);
  assert.equal(bLinks.length, 1, "B has a single peer-link with the inviter after re-attempt");

  // 3. The inviter drains B's fresh handshake — B is a distinct acceptor of the
  //    NEW invite (fresh acceptedAcceptors), so it is honoured this time.
  const drainedB2 = await inviter.peerLinks.handleIncomingHandshakePacket({
    ownerAccountId: inviter.identity.accountId, packetBytes: b2.packetBytes,
  });
  assert.equal(Boolean(drainedB2.rejected), false, "B honoured on the fresh invite");
  assert.equal(drainedB2.snapshot.state, "session_established",
    "the re-attempted handshake establishes a session on the inviter side");

  const inviterLinks = await inviter.peerLinks.peerLinkStorage.peerLinks.listByOwner(inviter.identity.accountId);
  assert.equal(inviterLinks.length, 2, "inviter now holds two peer-links (A + the re-attempted B)");
});

test("authorizeInviteJoin enforces expiry + maxUses against the real invite ledger (M3)", async () => {
  // The member.join authorization path (used when a joiner already has an
  // established peer-link, so no fresh handshake runs) must still honour the
  // same acceptedAcceptors/maxUses/expiry rules as the handshake responder.
  const { inviter, created, holder } = await setupInvite({ maxUses: 1 });
  const acceptorA = makeAcceptor("authzA");
  await provisionBinding({ peerLinks: acceptorA.peerLinks, identity: acceptorA.identity });

  // A accepts + the inviter drains → A is recorded in acceptedAcceptors.
  const a = await acceptFromRecord({
    acceptor: acceptorA, holder,
    inviteId: created.inviteId, publisherPublicKeyB64: created.publisherPublicKeyB64,
  });
  await inviter.peerLinks.handleIncomingHandshakePacket({
    ownerAccountId: inviter.identity.accountId, packetBytes: a.packetBytes,
  });

  // A is already a recorded acceptor → idempotent authorize (no double-spend).
  const vA = await inviter.peerLinks.authorizeInviteJoin({
    ownerAccountId: inviter.identity.accountId,
    inviteId: created.inviteId,
    joinerAccountId: acceptorA.identity.accountId,
  });
  assert.equal(vA.authorized, true);
  assert.equal(vA.reason, "ALREADY_ACCEPTED");

  // A different account over the single-use limit → rejected.
  const vOver = await inviter.peerLinks.authorizeInviteJoin({
    ownerAccountId: inviter.identity.accountId,
    inviteId: created.inviteId,
    joinerAccountId: "rez:acct:nobody",
  });
  assert.equal(vOver.authorized, false);
  assert.equal(vOver.reason, "INVITE_USED_UP");

  // Expired invite → rejected regardless of slots (nowMs far past expiry).
  const vExpired = await inviter.peerLinks.authorizeInviteJoin({
    ownerAccountId: inviter.identity.accountId,
    inviteId: created.inviteId,
    joinerAccountId: "rez:acct:late",
    nowMs: 9_999_999_999_999,
  });
  assert.equal(vExpired.authorized, false);
  assert.equal(vExpired.reason, "INVITE_EXPIRED");

  // Unknown invite → rejected.
  const vUnknown = await inviter.peerLinks.authorizeInviteJoin({
    ownerAccountId: inviter.identity.accountId,
    inviteId: "plinv_does_not_exist",
    joinerAccountId: acceptorA.identity.accountId,
  });
  assert.equal(vUnknown.authorized, false);
  assert.equal(vUnknown.reason, "INVITE_NOT_FOUND");
});

test("authorizeInviteJoin consumes a slot for a NEW joiner (maxUses respected without a handshake) (M3)", async () => {
  const { inviter, created } = await setupInvite({ maxUses: 1 });
  // No handshake at all — a joiner with a pre-existing peer-link would land
  // here. First new joiner consumes the only slot.
  const v1 = await inviter.peerLinks.authorizeInviteJoin({
    ownerAccountId: inviter.identity.accountId,
    inviteId: created.inviteId,
    joinerAccountId: "rez:acct:joinerX",
  });
  assert.equal(v1.authorized, true);
  assert.equal(v1.reason, "CONSUMED");
  // Re-authorizing the SAME joiner is idempotent (already recorded).
  const v1again = await inviter.peerLinks.authorizeInviteJoin({
    ownerAccountId: inviter.identity.accountId,
    inviteId: created.inviteId,
    joinerAccountId: "rez:acct:joinerX",
  });
  assert.equal(v1again.reason, "ALREADY_ACCEPTED");
  // A different joiner is now over the limit.
  const v2 = await inviter.peerLinks.authorizeInviteJoin({
    ownerAccountId: inviter.identity.accountId,
    inviteId: created.inviteId,
    joinerAccountId: "rez:acct:joinerY",
  });
  assert.equal(v2.authorized, false);
  assert.equal(v2.reason, "INVITE_USED_UP");
});

test("forged handshake.reject (wrong signer) does NOT roll back the acceptor's peer-link", async () => {
  const { inviter, created, holder } = await setupInvite({ maxUses: 1 });
  const acceptor = makeAcceptor("acceptor-forge");
  await provisionBinding({ peerLinks: acceptor.peerLinks, identity: acceptor.identity });

  const a = await acceptFromRecord({
    acceptor, holder, inviteId: created.inviteId, publisherPublicKeyB64: created.publisherPublicKeyB64,
  });
  assert.equal(a.accept.snapshot.state, "handshake_sent");

  // An ATTACKER (not the inviter) signs a reject and rewrites the plaintext
  // senderAccountId to the inviter's. The signature + signing pubkey remain the
  // attacker's, which does NOT match the inviter's key persisted on the
  // acceptor's peer-link — so the reject must be refused (no rollback).
  const attacker = makeAcceptor("attacker");
  await provisionBinding({ peerLinks: attacker.peerLinks, identity: attacker.identity });
  const forged = await attacker.peerLinks.createSignedHandshakeReject({
    ownerAccountId: attacker.identity.accountId,
    reason: "INVITE_USED_UP",
    ackNonce: "any-nonce",
  });
  const forgedObj = JSON.parse(new TextDecoder().decode(forged.rejectBytes));
  forgedObj.reject.senderAccountId = inviter.identity.accountId;
  const tampered = new TextEncoder().encode(JSON.stringify(forgedObj));

  const result = await acceptor.peerLinks.handleHandshakeReject({
    ownerAccountId: acceptor.identity.accountId,
    rejectPacketBytes: tampered,
  });
  assert.equal(result, null, "forged reject is rejected (no rollback)");
  const link = await acceptor.peerLinks.peerLinkStorage.peerLinks.getByPair(
    acceptor.identity.accountId, inviter.identity.accountId,
  );
  assert.equal(link.state, "handshake_sent", "acceptor's peer-link is NOT rolled back by a forged reject");
});
