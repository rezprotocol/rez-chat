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
 * Cross-leaf invite e2e — the topology proof the regression slipped through.
 *
 * `server.invites.offline-inviter.e2e.test.js` proves the invite CRYPTO end to
 * end, but both sides put/get against a SINGLE peerless holder node. That never
 * exercises the production shape — two users on different leaf nodes, each
 * connected only to its own entry relay — which is exactly where invites broke
 * (`acceptInvite: invite envelope not found`) even with the inviter online: a
 * sparse leaf's own iterative lookup can't traverse the relay core to the holder.
 *
 * Release 5f4f41c shipped that regression because the chat-layer e2e used one
 * node and the rez-node star test that DOES model the core lived in a different
 * repo — nothing exercised both together. This is that missing seam: the real
 * chat invite flow (real PeerLinkService, real chat-server-signed durable record,
 * real X3DH) over the real star-with-core node topology.
 *
 *   leafA (inviter) ── relay0 ═══ relay1 ── leafB (acceptor)
 *                                            (── leaf link, ═══ core link)
 *
 * The inviter publishes via leafA → the record lands on relay0 ONLY. The
 * acceptor fetches via leafB, whose only peer is relay1; resolving the record
 * REQUIRES relay1 to traverse the core to relay0 on the leaf's behalf. Proven
 * with the inviter ONLINE and OFFLINE.
 */

const CRYPTO = new NodeCryptoProvider();

// ---- chat-identity + peer-link harness (mirrors the offline-inviter e2e) ----

function makeChatIdentity() {
  const keyPair = CRYPTO.generateSigningKeyPair();
  return {
    accountId: deriveAccountIdFromPublicKey(keyPair.publicKey),
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

function makeParticipant(label) {
  const identity = makeChatIdentity();
  const inbox = "inbox:" + label;
  const authority = buildChatServerInviteAuthority({
    accountId: identity.accountId,
    identity,
    cryptoProvider: CRYPTO,
  });
  const peerLinks = makePeerLinks({ identity, inboxId: inbox, getInviteAuthority: () => authority });
  return { identity, inbox, peerLinks };
}

// ---- star-with-core node topology (mirrors the rez-node star integration) ---

function makeNode(relayKeyId, clock) {
  const registry = new ControlMessageRegistry();
  const node = new DhtNode({
    selfRelayKeyId: relayKeyId,
    controlMessageRegistry: registry,
    encodeCtl: (obj) => new TextEncoder().encode(JSON.stringify(obj)),
    trySendFrame: deliver,
    nowMs: () => clock.now,
    config: { k: 20, alpha: 3, queryTimeoutMs: 2000, recordReplicateIntervalMs: 0 },
  });
  node.install();
  return { relayKeyId, registry, node, alive: true };
}

// Directed-socket delivery: a write returns immediately; the frame dispatches
// on the peer in a later tick. A dead endpoint (peer.alive === false) silently
// drops — that is how an OFFLINE leaf is modelled.
function deliver(socket, bytes) {
  if (!socket || socket.destroyed === true) return;
  const peer = socket._peer;
  if (!peer || !peer.alive) return;
  const obj = JSON.parse(new TextDecoder().decode(bytes));
  queueMicrotask(() => {
    if (!peer.alive || socket.destroyed === true) return;
    peer.registry.dispatch(obj._ctl, obj, socket._peerSocket).catch(() => {});
  });
}

// Wire a bidirectional directed-socket pair. The relay←leaf asymmetry (a relay
// does NOT add a leaf to its k-buckets) is modelled by leaving bAddsA false on a
// leaf→relay link; both endpoints still exist so the relay can REPLY on the
// arrival socket without having added the leaf as a routing peer.
function connect(a, b, { aAddsB = true, bAddsA = true } = {}) {
  const epAB = { id: a.relayKeyId + "->" + b.relayKeyId, destroyed: false };
  const epBA = { id: b.relayKeyId + "->" + a.relayKeyId, destroyed: false };
  epAB._peer = b; epAB._peerSocket = epBA;
  epBA._peer = a; epBA._peerSocket = epAB;
  if (aAddsB) a.node.addPeer(b.relayKeyId, epAB);
  if (bAddsA) b.node.addPeer(a.relayKeyId, epBA);
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

// leafA ── relay0 ═══ relay1 ── leafB, with the leaf←relay k-bucket asymmetry.
function buildStarCore() {
  const clock = { now: Date.now() };
  const relay0 = makeNode("relay-core-0", clock);
  const relay1 = makeNode("relay-core-1", clock);
  connect(relay0, relay1, { aAddsB: true, bAddsA: true });

  const leafA = makeNode("leaf-A", clock);
  const leafB = makeNode("leaf-B", clock);
  connect(leafA, relay0, { aAddsB: true, bAddsA: false });
  connect(leafB, relay1, { aAddsB: true, bAddsA: false });

  // Topology invariants: a leaf knows only its entry relay; a relay knows only
  // the other relay (NOT the leaves).
  assert.equal(leafA.node.kBuckets.size, 1, "leafA knows only relay0");
  assert.equal(leafB.node.kBuckets.size, 1, "leafB knows only relay1");
  assert.equal(relay0.node.kBuckets.size, 1, "relay0 knows only relay1 (not leafA)");
  assert.equal(relay1.node.kBuckets.size, 1, "relay1 knows only relay0 (not leafB)");

  return { clock, relay0, relay1, leafA, leafB };
}

// Resolve the invite envelope from a durable record fetched THROUGH a given
// leaf node (so the resolve must cross the core) and run the acceptor's real
// X3DH accept, capturing the handshake packet.
async function acceptAcrossCore({ acceptor, viaLeaf, inviteId, publisherPublicKeyB64 }) {
  const fetched = await viaLeaf.node.getRecord({
    recordKind: PEERLINK_INVITE_RECORD_KIND,
    recordId: inviteId,
    publisherPublicKeyB64,
  });
  assert.ok(fetched && typeof fetched.payloadB64 === "string",
    "leafB resolved the invite record across the relay core");
  const payload = JSON.parse(new TextDecoder().decode(base64ToBytes(fetched.payloadB64)));
  assert.ok(payload && payload.envelope, "resolved payload carries the signed envelope");

  let packetBytes = null;
  let deliveredInbox = null;
  const accept = await acceptor.peerLinks.acceptInvite({
    envelope: payload.envelope,
    signatureB64: payload.signatureB64,
    acceptorAccountId: acceptor.identity.accountId,
    acceptorDisplayName: acceptor.inbox,
    senderInboxId: acceptor.inbox,
    sendHandshake: async ({ deliverInboxId, handshakePacket }) => {
      deliveredInbox = deliverInboxId;
      packetBytes = handshakePacket.toBytes();
      return {};
    },
  });
  return { accept, packetBytes, deliveredInbox, fetched };
}

test("cross-leaf invite (inviter ONLINE): acceptor on a different leaf resolves the record across the relay core and establishes a session", async () => {
  const { relay0, relay1, leafA, leafB } = buildStarCore();

  const inviter = makeParticipant("xleaf-inviter");
  const acceptor = makeParticipant("xleaf-acceptor");
  await provisionBinding({ peerLinks: inviter.peerLinks, identity: inviter.identity });
  await provisionBinding({ peerLinks: acceptor.peerLinks, identity: acceptor.identity });

  // Inviter mints + signs the invite and its durable record.
  const created = await inviter.peerLinks.createInvite({
    ownerAccountId: inviter.identity.accountId,
    creatorDisplayName: "Inviter",
    kind: "direct",
    maxUses: 1,
    expiresAtMs: Date.now() + 60_000,
    peerInboxId: inviter.inbox,
  });
  assert.ok(created.durableRecord, "createInvite returns a signed durable record");

  // The inviter (on leafA) publishes. The record lands on leafA's entry relay
  // (relay0) — NOT on relay1, and NOT on leafB.
  const put = await leafA.node.putRecord(created.durableRecord);
  assert.equal(put.stored, true, "node accepts the chat-server-signed record: " + put.reason);
  await flush();

  // Mechanism check: the put only reaches leafA's entry relay (leafA knows
  // only relay0), so the sole core-resident copy is on relay0. relay1 and leafB
  // hold nothing — resolving the record REQUIRES crossing the core.
  assert.equal(relay0.node.recordStore.size, 1, "relay0 (inviter entry) holds the record");
  assert.equal(relay1.node.recordStore.size, 0, "relay1 (acceptor entry) does NOT hold it");
  assert.equal(leafB.node.recordStore.size, 0, "leafB has no local copy");

  // Acceptor on leafB accepts — the record resolves across the core (inviter
  // online), real X3DH runs, handshake targets the inviter's inbox.
  const { accept, packetBytes, deliveredInbox } = await acceptAcrossCore({
    acceptor, viaLeaf: leafB,
    inviteId: created.inviteId, publisherPublicKeyB64: created.publisherPublicKeyB64,
  });
  assert.ok(accept && accept.snapshot, "acceptInvite returns a snapshot");
  assert.equal(accept.snapshot.localAccountId, acceptor.identity.accountId);
  assert.equal(accept.snapshot.peerAccountId, inviter.identity.accountId);
  assert.equal(deliveredInbox, inviter.inbox, "handshake targets the inviter's inbox");
  assert.ok(packetBytes instanceof Uint8Array && packetBytes.length > 0, "a real X3DH packet was produced");

  // Inviter drains the handshake → session_established (full loop closed).
  const drained = await inviter.peerLinks.handleIncomingHandshakePacket({
    ownerAccountId: inviter.identity.accountId,
    packetBytes,
  });
  assert.equal(Boolean(drained.rejected), false, "inviter honours the cross-leaf acceptor");
  const inviterLinks = await inviter.peerLinks.peerLinkStorage.peerLinks.listByOwner(inviter.identity.accountId);
  assert.equal(inviterLinks.length, 1, "inviter holds exactly one peer-link");
  assert.equal(inviterLinks[0].peerAccountId, acceptor.identity.accountId);
  assert.equal(inviterLinks[0].state, "session_established",
    "cross-leaf invite reaches session_established");
});

test("cross-leaf invite (inviter OFFLINE): the record outlives the inviter leaf on the relay core and still resolves at the acceptor leaf", async () => {
  const { relay0, relay1, leafA, leafB } = buildStarCore();

  const inviter = makeParticipant("xleaf-off-inviter");
  const acceptor = makeParticipant("xleaf-off-acceptor");
  await provisionBinding({ peerLinks: inviter.peerLinks, identity: inviter.identity });
  await provisionBinding({ peerLinks: acceptor.peerLinks, identity: acceptor.identity });

  const created = await inviter.peerLinks.createInvite({
    ownerAccountId: inviter.identity.accountId,
    creatorDisplayName: "Inviter",
    kind: "direct",
    maxUses: 1,
    expiresAtMs: Date.now() + 60_000,
    peerInboxId: inviter.inbox,
  });
  const put = await leafA.node.putRecord(created.durableRecord);
  assert.equal(put.stored, true, "node accepts the record: " + put.reason);
  await flush();

  // The sole core-resident copy is on relay0 (leafA's entry relay).
  assert.equal(relay0.node.recordStore.size, 1, "relay0 holds the record before the inviter leaves");
  assert.equal(relay1.node.recordStore.size, 0, "relay1 does not hold it (resolve must cross the core)");

  // The inviter goes OFFLINE: its leaf node is unreachable from here on. The
  // record persists on the relay core (relay0), independent of the publisher
  // leaf — exactly the hold-and-serve property offline invites depend on.
  leafA.alive = false;
  assert.equal(relay0.node.recordStore.size, 1, "relay0 still holds the record with the inviter leaf offline");

  // Acceptor on leafB resolves across the core from relay0 (not from leafA) and
  // runs X3DH with the inviter offline — no inviter contact.
  const { accept, packetBytes } = await acceptAcrossCore({
    acceptor, viaLeaf: leafB,
    inviteId: created.inviteId, publisherPublicKeyB64: created.publisherPublicKeyB64,
  });
  assert.ok(accept && accept.snapshot, "acceptInvite succeeds with the inviter offline");
  assert.equal(accept.snapshot.peerAccountId, inviter.identity.accountId);
  assert.ok(packetBytes instanceof Uint8Array && packetBytes.length > 0,
    "a real X3DH packet was produced offline");

  // The inviter comes back and drains the buffered handshake → session_established.
  leafA.alive = true;
  const drained = await inviter.peerLinks.handleIncomingHandshakePacket({
    ownerAccountId: inviter.identity.accountId,
    packetBytes,
  });
  assert.equal(Boolean(drained.rejected), false, "inviter honours the acceptor on return");
  const inviterLinks = await inviter.peerLinks.peerLinkStorage.peerLinks.listByOwner(inviter.identity.accountId);
  assert.equal(inviterLinks.length, 1, "inviter holds one peer-link after draining the buffered handshake");
  assert.equal(inviterLinks[0].state, "session_established",
    "offline cross-leaf invite reaches session_established on return");
});
