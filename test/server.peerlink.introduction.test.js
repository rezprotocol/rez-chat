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
  MeshCapability,
} from "@rezprotocol/sdk/client";
import { PeerLinkService } from "@rezprotocol/sdk/peer-link";
import { NodeCryptoProvider } from "@rezprotocol/node";

import { ServerPeerLinkProtocolService } from "../src/server/services/ServerPeerLinkProtocolService.js";

/**
 * Peer-link INTRODUCTION coverage — the mesh bootstrap for two group members who
 * never invited each other (A invited B, B invited C ⇒ A and C share no invite
 * and no prior link). The introduction reuses the existing X3DH establishment;
 * these tests prove (1) the crypto core establishes a brand-new bidirectional
 * link with no prior pair and the session actually works, and (2) the chat-server
 * routing applies the co-membership authorization gate (buffering, not dropping,
 * when the sender isn't yet known as a co-member). See
 * project_group_peerlinks_invite_tree_not_mesh.
 */

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

function makeFakeBus({ runtime, stores = {} } = {}) {
  const emits = [];
  return {
    runtime,
    services: {},
    stores,
    on() { return () => {}; },
    emit(name, payload) { emits.push({ name, payload }); },
    registerFunction() {},
    call() { return Promise.resolve(null); },
    emits,
  };
}

async function establishedPeerAccountIds(peerLinks, ownerAccountId) {
  const result = await peerLinks.listPeerLinks({ ownerAccountId });
  const items = result && Array.isArray(result.items) ? result.items : [];
  return items
    .filter((it) => it && it.state === "session_established")
    .map((it) => it.peerAccountId);
}

test("introduction establishes a brand-new bidirectional link with no prior pair, and the session works", async () => {
  const aliceIdentity = createSessionIdentity();
  const carolIdentity = createSessionIdentity();
  const aliceAccountId = aliceIdentity.accountId;
  const carolAccountId = carolIdentity.accountId;
  const aliceInboxId = "inbox:alice-intro";
  const carolInboxId = "inbox:carol-intro";

  const getInviteAuthority = makeAuthorityProvider([aliceAccountId, carolAccountId]);
  const alicePeerLinks = makePeerLinkService({ accountId: aliceAccountId, inboxId: aliceInboxId, getInviteAuthority });
  const carolPeerLinks = makePeerLinkService({ accountId: carolAccountId, inboxId: carolInboxId, getInviteAuthority });
  await provisionPeerLinkBinding({ peerLinks: alicePeerLinks, identity: aliceIdentity });
  await provisionPeerLinkBinding({ peerLinks: carolPeerLinks, identity: carolIdentity });

  // Precondition: neither side has any peer link.
  assert.equal((await alicePeerLinks.listPeerLinks({ ownerAccountId: aliceAccountId })).items.length, 0);
  assert.equal((await carolPeerLinks.listPeerLinks({ ownerAccountId: carolAccountId })).items.length, 0);

  // The deterministic initiator is the lexicographically-smaller accountId; the
  // crypto core is symmetric, so drive the pair in whichever role they land in.
  const initiator = aliceAccountId < carolAccountId
    ? { peerLinks: alicePeerLinks, accountId: aliceAccountId, inboxId: aliceInboxId }
    : { peerLinks: carolPeerLinks, accountId: carolAccountId, inboxId: carolInboxId };
  const responder = aliceAccountId < carolAccountId
    ? { peerLinks: carolPeerLinks, accountId: carolAccountId, inboxId: carolInboxId }
    : { peerLinks: alicePeerLinks, accountId: aliceAccountId, inboxId: aliceInboxId };

  // 1. Initiator requests the introduction (no prior link).
  const req = await initiator.peerLinks.requestPeerLinkIntroduction({
    ownerAccountId: initiator.accountId,
    peerAccountId: responder.accountId,
    peerInboxId: responder.inboxId,
    senderInboxId: initiator.inboxId,
  });
  assert.equal(req.alreadyLinked, false);
  assert.ok(req.introductionId, "introduction produced an id");
  assert.ok(req.introductionRecord && typeof req.introductionRecord.toBytes === "function");

  // 2. Responder handles the introduction → returns a handshake to send back.
  const intro = req.introductionRecord;
  const onResponder = await responder.peerLinks.handleIncomingIntroduction({
    ownerAccountId: responder.accountId,
    ownerInboxId: responder.inboxId,
    introductionId: intro.introductionId,
    senderAccountId: intro.senderAccountId,
    senderInboxId: intro.senderInboxId,
    bundleJson: intro.bundleJson,
  });
  assert.ok(onResponder && onResponder.handshakePacket, "responder produced a handshake response");
  assert.equal(onResponder.deliverInboxId, initiator.inboxId);

  // 3. Initiator completes the introduction from the handshake response.
  const done = await initiator.peerLinks.handleIntroductionResponse({
    ownerAccountId: initiator.accountId,
    packetBytes: onResponder.handshakePacket.toBytes(),
  });
  assert.ok(done && done.snapshot, "initiator completed the introduction");

  // Both sides now hold an established link to each other.
  assert.deepEqual(await establishedPeerAccountIds(initiator.peerLinks, initiator.accountId), [responder.accountId]);
  assert.deepEqual(await establishedPeerAccountIds(responder.peerLinks, responder.accountId), [initiator.accountId]);

  // The session actually works: encrypt initiator→responder and decrypt.
  const plaintext = new TextEncoder().encode("hello across the mesh");
  const enc = await initiator.peerLinks.encryptDirectMessage({
    ownerAccountId: initiator.accountId,
    peerAccountId: responder.accountId,
    plaintextBytes: plaintext,
  });
  const dec = await responder.peerLinks.decryptDirectMessageAnyPeer({
    ownerAccountId: responder.accountId,
    packetBytes: enc.encryptedPacket.toBytes(),
  });
  assert.deepEqual(Array.from(dec.plaintextBytes), Array.from(plaintext));
});

test("introduction is idempotent — a duplicate request when already linked is a no-op", async () => {
  const aliceIdentity = createSessionIdentity();
  const carolIdentity = createSessionIdentity();
  const a = aliceIdentity.accountId;
  const c = carolIdentity.accountId;
  const getInviteAuthority = makeAuthorityProvider([a, c]);
  const alice = makePeerLinkService({ accountId: a, inboxId: "inbox:a-idem", getInviteAuthority });
  const carol = makePeerLinkService({ accountId: c, inboxId: "inbox:c-idem", getInviteAuthority });
  await provisionPeerLinkBinding({ peerLinks: alice, identity: aliceIdentity });
  await provisionPeerLinkBinding({ peerLinks: carol, identity: carolIdentity });

  const init = a < c
    ? { pl: alice, id: a, inbox: "inbox:a-idem" }
    : { pl: carol, id: c, inbox: "inbox:c-idem" };
  const resp = a < c
    ? { pl: carol, id: c, inbox: "inbox:c-idem" }
    : { pl: alice, id: a, inbox: "inbox:a-idem" };

  const req = await init.pl.requestPeerLinkIntroduction({
    ownerAccountId: init.id, peerAccountId: resp.id, peerInboxId: resp.inbox, senderInboxId: init.inbox,
  });
  const onResp = await resp.pl.handleIncomingIntroduction({
    ownerAccountId: resp.id, ownerInboxId: resp.inbox,
    introductionId: req.introductionRecord.introductionId,
    senderAccountId: req.introductionRecord.senderAccountId,
    senderInboxId: req.introductionRecord.senderInboxId,
    bundleJson: req.introductionRecord.bundleJson,
  });
  await init.pl.handleIntroductionResponse({ ownerAccountId: init.id, packetBytes: onResp.handshakePacket.toBytes() });

  // Re-request after established → alreadyLinked, no new request record.
  const again = await init.pl.requestPeerLinkIntroduction({
    ownerAccountId: init.id, peerAccountId: resp.id, peerInboxId: resp.inbox, senderInboxId: init.inbox,
  });
  assert.equal(again.alreadyLinked, true);
  assert.equal(again.introductionRecord, null);
});

test("ServerPeerLinkProtocolService gates an introduction on co-membership (buffer when unknown, process when co-member)", async () => {
  const aliceIdentity = createSessionIdentity();
  const carolIdentity = createSessionIdentity();
  const aliceAccountId = aliceIdentity.accountId;
  const carolAccountId = carolIdentity.accountId;
  const aliceInboxId = "inbox:alice-authz";
  const carolInboxId = "inbox:carol-authz";

  const getInviteAuthority = makeAuthorityProvider([aliceAccountId, carolAccountId]);
  const alicePeerLinks = makePeerLinkService({ accountId: aliceAccountId, inboxId: aliceInboxId, getInviteAuthority });
  const carolPeerLinks = makePeerLinkService({ accountId: carolAccountId, inboxId: carolInboxId, getInviteAuthority });
  await provisionPeerLinkBinding({ peerLinks: alicePeerLinks, identity: aliceIdentity });
  await provisionPeerLinkBinding({ peerLinks: carolPeerLinks, identity: carolIdentity });

  // Alice initiates an introduction to Carol; we route the resulting introduce
  // packet through Carol's chat-server protocol service.
  const req = await alicePeerLinks.requestPeerLinkIntroduction({
    ownerAccountId: aliceAccountId,
    peerAccountId: carolAccountId,
    peerInboxId: carolInboxId,
    senderInboxId: aliceInboxId,
  });
  const ciphertextB64 = Buffer.from(req.introductionRecord.toBytes()).toString("base64");

  // --- Not a co-member yet: must BUFFER (consumed:false), not drop. ---
  let coMember = false;
  const deposits = [];
  const mailbox = { deposit: async (opts) => { deposits.push(opts); return { eventId: "evt:" + deposits.length }; } };
  const carolSdk = {
    mailbox,
    mesh: new MeshCapability({ pool: null, mailbox }),
    getIdentity: () => ({ localInboxId: carolInboxId }),
  };
  const groupStore = { isCoMember: async () => coMember };
  const bus = makeFakeBus({ runtime: { peerLinks: carolPeerLinks, sdk: carolSdk }, stores: { groupStore } });
  const protocolService = new ServerPeerLinkProtocolService({
    bus, ownerAccountId: carolAccountId,
    logger: { log() {}, info() {}, warn() {}, error() {} },
  });

  const buffered = await protocolService.processDeposit({
    body: { eventId: "evt:intro:1", mailboxId: carolInboxId, ciphertextB64 },
  });
  assert.equal(buffered.consumed, false, "unknown co-member must leave the introduce buffered");
  assert.equal(buffered.reason, "introduction-not-co-member");
  assert.equal(deposits.length, 0, "no handshake response sent to a non-co-member");

  // --- Now a co-member: must PROCESS and dispatch a handshake back to Alice. ---
  coMember = true;
  const processed = await protocolService.processDeposit({
    body: { eventId: "evt:intro:1", mailboxId: carolInboxId, ciphertextB64 },
  });
  assert.equal(processed.consumed, true, "co-member introduce is processed");
  assert.equal(deposits.length, 1, "handshake response dispatched back to the initiator");
  assert.equal(deposits[0].mailboxId, aliceInboxId);

  // Carol now holds an established link to Alice; feeding the response back to
  // Alice completes her side too.
  assert.deepEqual(await establishedPeerAccountIds(carolPeerLinks, carolAccountId), [aliceAccountId]);
  const responseBytes = Buffer.from(deposits[0].ciphertextB64, "base64");
  await alicePeerLinks.handleIntroductionResponse({ ownerAccountId: aliceAccountId, packetBytes: responseBytes });
  assert.deepEqual(await establishedPeerAccountIds(alicePeerLinks, aliceAccountId), [carolAccountId]);
});
