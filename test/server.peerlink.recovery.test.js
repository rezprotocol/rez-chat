// Recovery-via-reinvite — the unified peer-link recovery path that replaced the
// bespoke rehandshake + introduction protocols. When a link desyncs (or a group
// co-member has no link yet), the detector simply RE-INVITES the contact over the
// proven invite/accept path: createInvite -> dispatch a recovery-invite body ->
// the peer accepts (forceReestablish) -> the handshake rides back as a regular
// x3dh.handshake.v2 the inviter completes. No new packet types, no glare state.
//
// Coverage:
//   - THREAD_NOT_READY (single eligible candidate) triggers a recovery invite.
//   - the per-peer trigger cooldown coalesces a burst.
//   - end-to-end DM recovery: re-invite -> accept(forceReestablish) -> handshake
//     -> ack, and the re-established link decrypts BOTH directions.
//   - crossing invites (glare): both sides re-invite at once; the canonical
//     (smaller accountId) inviter wins and a SINGLE matched pair results.
//   - authz: a recovery invite from a stranger (no link, not a co-member) is left
//     buffered, never accepted; a co-member with no link IS accepted (group
//     bootstrap).

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
const SILENT = { log() {}, info() {}, warn() {}, error() {} };

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

function makePeerLinkService({ accountId, inboxId, getInviteAuthority, clock = () => Date.now() }) {
  return new PeerLinkService({
    storageProvider: createDefaultStorageProvider(),
    clock,
    ownerAccountId: accountId,
    getInviteAuthority,
    inviteBinding: { mailboxId: inboxId, capabilityId: inboxId },
    cryptoProvider: new NodeCryptoProvider(),
  });
}

function makeFakeBus({ runtime, groupStore = null } = {}) {
  return {
    runtime,
    services: {},
    stores: groupStore ? { groupStore } : {},
    on() { return () => {}; },
    emit() {},
    registerFunction() {},
    call() { return Promise.resolve(null); },
  };
}

// A chat-server protocol service backed by a REAL PeerLinkService, with a fake
// mesh that records dispatched objects so a test can route them peer-to-peer.
function makeNode({ peerLinks, inboxId, groupStore = null, clock }) {
  const dispatched = [];
  const fakeSdk = {
    mesh: { async dispatch(object, address) { dispatched.push({ object, address }); } },
    getIdentity: () => ({ localInboxId: inboxId }),
  };
  const bus = makeFakeBus({ runtime: { peerLinks, sdk: fakeSdk }, groupStore });
  const service = new ServerPeerLinkProtocolService({
    bus,
    ownerAccountId: peerLinks.ownerAccountId,
    clock,
    logger: SILENT,
  });
  return { service, dispatched, inboxId, cursor: 0, peerLinks };
}

// Deliver every undelivered dispatched object to the node whose inbox matches its
// address, running processDeposit to completion. Loops until no new dispatches —
// so a re-invite -> handshake -> ack chain fully settles. Returns nothing.
async function pump(nodes) {
  let moved = true;
  let guard = 0;
  while (moved && guard < 30) {
    moved = false;
    guard += 1;
    for (const src of nodes) {
      while (src.cursor < src.dispatched.length) {
        const { object, address } = src.dispatched[src.cursor];
        src.cursor += 1;
        const inboxId = address && typeof address.inboxId === "string" ? address.inboxId : "";
        const target = nodes.find((n) => n.inboxId === inboxId);
        if (!target) continue;
        await target.service.processDeposit({
          body: {
            ciphertextB64: bytesToBase64(object.payloadBytes),
            mailboxId: target.inboxId,
            eventId: "evt_" + guard + "_" + src.cursor,
          },
        });
        moved = true;
      }
    }
  }
}

async function waitUntil(predicate, tries = 100) {
  for (let i = 0; i < tries; i += 1) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error("waitUntil timed out");
}

// Establish Alice (inviter) -> Bob so both hold an active peer-link to the other.
async function establishInviterToAcceptor({ aliceIdentity, bobIdentity, aliceInboxId, bobInboxId, getInviteAuthority }) {
  const alicePeerLinks = makePeerLinkService({ accountId: aliceIdentity.accountId, inboxId: aliceInboxId, getInviteAuthority });
  const bobPeerLinks = makePeerLinkService({ accountId: bobIdentity.accountId, inboxId: bobInboxId, getInviteAuthority });
  await provisionPeerLinkBinding({ peerLinks: alicePeerLinks, identity: aliceIdentity });
  await provisionPeerLinkBinding({ peerLinks: bobPeerLinks, identity: bobIdentity });

  const created = await alicePeerLinks.createInvite({ ownerAccountId: aliceIdentity.accountId, maxUses: 1, expiresAtMs: Date.now() + 60_000 });
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
  const received = await alicePeerLinks.handleIncomingHandshakePacket({
    ownerAccountId: aliceIdentity.accountId,
    packetBytes: capturedHandshakePacket.toBytes(),
  });
  const { ackBytes } = await alicePeerLinks.createSignedHandshakeAck({
    ownerAccountId: aliceIdentity.accountId, ownerInboxId: aliceInboxId, ackNonce: received.ackNonce,
  });
  await bobPeerLinks.handleIncomingHandshakeAck({ ownerAccountId: bobIdentity.accountId, ackPacketBytes: ackBytes });
  return { alicePeerLinks, bobPeerLinks };
}

const enc = (s) => new TextEncoder().encode(s);
const dec = (b) => new TextDecoder().decode(b);

async function assertBidirectional(aPeerLinks, aId, bPeerLinks, bId) {
  const m1 = await aPeerLinks.encryptDirectMessage({ ownerAccountId: aId, peerAccountId: bId, plaintextBytes: enc("a->b") });
  const d1 = await bPeerLinks.decryptDirectMessageAnyPeer({ ownerAccountId: bId, packetBytes: m1.encryptedPacket.toBytes() });
  assert.equal(dec(d1.plaintextBytes), "a->b", "b decrypts a's message");
  const m2 = await bPeerLinks.encryptDirectMessage({ ownerAccountId: bId, peerAccountId: aId, plaintextBytes: enc("b->a") });
  const d2 = await aPeerLinks.decryptDirectMessageAnyPeer({ ownerAccountId: aId, packetBytes: m2.encryptedPacket.toBytes() });
  assert.equal(dec(d2.plaintextBytes), "b->a", "a decrypts b's message");
}

test("THREAD_NOT_READY with one eligible candidate triggers a recovery invite to the peer inbox", async () => {
  const aliceIdentity = createSessionIdentity();
  const bobIdentity = createSessionIdentity();
  const getInviteAuthority = makeAuthorityProvider([aliceIdentity.accountId, bobIdentity.accountId]);
  const { alicePeerLinks } = await establishInviterToAcceptor({
    aliceIdentity, bobIdentity, aliceInboxId: "inbox:alice-rt", bobInboxId: "inbox:bob-rt", getInviteAuthority,
  });

  const dispatched = [];
  let resolveDispatch;
  const dispatchedOnce = new Promise((res) => { resolveDispatch = res; });
  const fakeSdk = {
    mesh: { async dispatch(object, address) { dispatched.push({ object, address }); resolveDispatch(); } },
    getIdentity: () => ({ localInboxId: "inbox:alice-rt" }),
  };
  const bus = makeFakeBus({ runtime: { peerLinks: alicePeerLinks, sdk: fakeSdk } });
  const service = new ServerPeerLinkProtocolService({ bus, ownerAccountId: aliceIdentity.accountId, logger: SILENT });

  service._triggerRecoveryInvite({ peerAccountId: bobIdentity.accountId });
  await dispatchedOnce;

  assert.equal(dispatched.length, 1, "exactly one recovery invite dispatched");
  assert.equal(dispatched[0].address.inboxId, "inbox:bob-rt", "dispatched to the peer's inbox");
  const wire = JSON.parse(new TextDecoder().decode(dispatched[0].object.payloadBytes));
  assert.equal(wire.kind, "rez.peerlink.recovery-invite.v1", "carries the recovery-invite kind");
  assert.ok(wire.envelope && typeof wire.envelope === "object", "carries an invite envelope");
  assert.equal(typeof wire.signatureB64, "string", "carries the envelope signature");
  assert.equal(wire.envelope.creatorAccountId, aliceIdentity.accountId, "invite is from Alice");
  // Short TTL so a stale/superseded invite auto-expires.
  assert.ok(wire.envelope.expiresAtMs - Date.now() <= 5 * 60 * 1000 + 1000, "recovery invite has a short TTL");
});

test("the recovery-invite trigger coalesces a burst to one invite per cooldown window", async () => {
  const aliceIdentity = createSessionIdentity();
  const bobIdentity = createSessionIdentity();
  const getInviteAuthority = makeAuthorityProvider([aliceIdentity.accountId, bobIdentity.accountId]);
  const { alicePeerLinks } = await establishInviterToAcceptor({
    aliceIdentity, bobIdentity, aliceInboxId: "inbox:alice-cd", bobInboxId: "inbox:bob-cd", getInviteAuthority,
  });

  let nowMs = 2_000_000;
  const dispatched = [];
  const fakeSdk = {
    mesh: { async dispatch(object, address) { dispatched.push({ object, address }); } },
    getIdentity: () => ({ localInboxId: "inbox:alice-cd" }),
  };
  const bus = makeFakeBus({ runtime: { peerLinks: alicePeerLinks, sdk: fakeSdk } });
  const service = new ServerPeerLinkProtocolService({ bus, ownerAccountId: aliceIdentity.accountId, clock: () => nowMs, logger: SILENT });

  for (let i = 0; i < 6; i += 1) service._triggerRecoveryInvite({ peerAccountId: bobIdentity.accountId });
  await waitUntil(() => dispatched.length >= 1);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(dispatched.length, 1, "burst coalesced to a single recovery invite");

  nowMs += 29_999;
  service._triggerRecoveryInvite({ peerAccountId: bobIdentity.accountId });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(dispatched.length, 1, "a trigger inside the cooldown window is suppressed");

  nowMs += 2;
  service._triggerRecoveryInvite({ peerAccountId: bobIdentity.accountId });
  await waitUntil(() => dispatched.length >= 2);
  assert.equal(dispatched.length, 2, "a trigger past the cooldown window dispatches again");
});

test("end-to-end DM recovery: re-invite -> accept(forceReestablish) -> handshake re-establishes a working link both directions", async () => {
  const aliceIdentity = createSessionIdentity();
  const bobIdentity = createSessionIdentity();
  const getInviteAuthority = makeAuthorityProvider([aliceIdentity.accountId, bobIdentity.accountId]);
  const { alicePeerLinks, bobPeerLinks } = await establishInviterToAcceptor({
    aliceIdentity, bobIdentity, aliceInboxId: "inbox:alice-e2e", bobInboxId: "inbox:bob-e2e", getInviteAuthority,
  });

  const alice = makeNode({ peerLinks: alicePeerLinks, inboxId: "inbox:alice-e2e" });
  const bob = makeNode({ peerLinks: bobPeerLinks, inboxId: "inbox:bob-e2e" });

  // Alice detects the desync and re-invites Bob; everything else flows by routing
  // the dispatched packets between the two nodes.
  alice.service._triggerRecoveryInvite({ peerAccountId: bobIdentity.accountId });
  await waitUntil(() => alice.dispatched.length >= 1);
  await pump([alice, bob]);

  await assertBidirectional(alicePeerLinks, aliceIdentity.accountId, bobPeerLinks, bobIdentity.accountId);
});

test("crossing recovery invites (glare) converge on a single matched pair", async () => {
  const aliceIdentity = createSessionIdentity();
  const bobIdentity = createSessionIdentity();
  const getInviteAuthority = makeAuthorityProvider([aliceIdentity.accountId, bobIdentity.accountId]);
  const { alicePeerLinks, bobPeerLinks } = await establishInviterToAcceptor({
    aliceIdentity, bobIdentity, aliceInboxId: "inbox:alice-glare", bobInboxId: "inbox:bob-glare", getInviteAuthority,
  });

  const alice = makeNode({ peerLinks: alicePeerLinks, inboxId: "inbox:alice-glare" });
  const bob = makeNode({ peerLinks: bobPeerLinks, inboxId: "inbox:bob-glare" });

  // BOTH sides detect the break and re-invite at once (the marker each sets makes
  // the accept-side glare tiebreak fire). The canonical (smaller accountId) wins.
  alice.service._triggerRecoveryInvite({ peerAccountId: bobIdentity.accountId });
  bob.service._triggerRecoveryInvite({ peerAccountId: aliceIdentity.accountId });
  await waitUntil(() => alice.dispatched.length >= 1 && bob.dispatched.length >= 1);
  await pump([alice, bob]);

  // Decisive: exactly one matched pair survived — both directions decrypt. Pre-fix
  // (single-session replace, no tiebreak) this left opposite halves and failed.
  await assertBidirectional(alicePeerLinks, aliceIdentity.accountId, bobPeerLinks, bobIdentity.accountId);
});

test("a recovery invite from a stranger (no link, not a co-member) is left buffered, never accepted", async () => {
  const aliceIdentity = createSessionIdentity();
  const strangerIdentity = createSessionIdentity();
  const getInviteAuthority = makeAuthorityProvider([aliceIdentity.accountId, strangerIdentity.accountId]);

  const alicePeerLinks = makePeerLinkService({ accountId: aliceIdentity.accountId, inboxId: "inbox:alice-strange", getInviteAuthority });
  const strangerPeerLinks = makePeerLinkService({ accountId: strangerIdentity.accountId, inboxId: "inbox:stranger", getInviteAuthority });
  await provisionPeerLinkBinding({ peerLinks: alicePeerLinks, identity: aliceIdentity });
  await provisionPeerLinkBinding({ peerLinks: strangerPeerLinks, identity: strangerIdentity });

  // Stranger mints a (validly-signed) invite to Alice, but Alice has no link to
  // them and they share no group — Alice must NOT establish a link.
  const created = await strangerPeerLinks.createInvite({ ownerAccountId: strangerIdentity.accountId, maxUses: 1, expiresAtMs: Date.now() + 60_000 });
  const env = await strangerPeerLinks.getStoredInviteEnvelope(strangerIdentity.accountId, created.inviteId);

  const dispatched = [];
  const fakeSdk = {
    mesh: { async dispatch(object, address) { dispatched.push({ object, address }); } },
    getIdentity: () => ({ localInboxId: "inbox:alice-strange" }),
  };
  // groupStore reports NO co-membership.
  const groupStore = { async isCoMember() { return false; } };
  const bus = makeFakeBus({ runtime: { peerLinks: alicePeerLinks, sdk: fakeSdk }, groupStore });
  const service = new ServerPeerLinkProtocolService({ bus, ownerAccountId: aliceIdentity.accountId, logger: SILENT });

  const payloadBytes = new TextEncoder().encode(JSON.stringify({
    kind: "rez.peerlink.recovery-invite.v1",
    envelope: env.envelope,
    signatureB64: env.signatureB64,
  }));
  const result = await service.processDeposit({
    body: { ciphertextB64: bytesToBase64(payloadBytes), mailboxId: "inbox:alice-strange", eventId: "evt:strange:1" },
  });

  assert.equal(result.consumed, false, "unauthorized recovery invite is left buffered, not acked");
  assert.equal(dispatched.length, 0, "no handshake sent for an unauthorized invite");
  const links = await alicePeerLinks.listPeerLinks({ ownerAccountId: aliceIdentity.accountId });
  assert.equal(links.items.find((it) => it.peerAccountId === strangerIdentity.accountId), undefined, "no link established");
});

test("group bootstrap: a recovery invite from a co-member with no prior link IS accepted", async () => {
  const aliceIdentity = createSessionIdentity();
  const carolIdentity = createSessionIdentity();
  const getInviteAuthority = makeAuthorityProvider([aliceIdentity.accountId, carolIdentity.accountId]);

  const alicePeerLinks = makePeerLinkService({ accountId: aliceIdentity.accountId, inboxId: "inbox:alice-grp", getInviteAuthority });
  const carolPeerLinks = makePeerLinkService({ accountId: carolIdentity.accountId, inboxId: "inbox:carol-grp", getInviteAuthority });
  await provisionPeerLinkBinding({ peerLinks: alicePeerLinks, identity: aliceIdentity });
  await provisionPeerLinkBinding({ peerLinks: carolPeerLinks, identity: carolIdentity });

  // Both consider each other co-members (shared group), but they never invited
  // each other — no peer-link exists yet.
  const groupStore = { async isCoMember() { return true; } };
  const alice = makeNode({ peerLinks: alicePeerLinks, inboxId: "inbox:alice-grp", groupStore });
  const carol = makeNode({ peerLinks: carolPeerLinks, inboxId: "inbox:carol-grp", groupStore });

  // Alice bootstraps a link to the co-member Carol.
  alice.service._triggerRecoveryInvite({ peerAccountId: carolIdentity.accountId, peerInboxId: "inbox:carol-grp" });
  await waitUntil(() => alice.dispatched.length >= 1);
  await pump([alice, carol]);

  const aliceLinks = await alicePeerLinks.listPeerLinks({ ownerAccountId: aliceIdentity.accountId });
  assert.ok(aliceLinks.items.find((it) => it.peerAccountId === carolIdentity.accountId), "Alice now links to the co-member");
  await assertBidirectional(alicePeerLinks, aliceIdentity.accountId, carolPeerLinks, carolIdentity.accountId);
});
