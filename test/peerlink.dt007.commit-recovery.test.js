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
import { DELIVERY_COMMIT_PREFIX, DeliveryCommitStore } from "@rezprotocol/sdk/delivery";
import { PeerLinkService } from "@rezprotocol/sdk/peer-link";
import { NodeCryptoProvider } from "@rezprotocol/node";

// DT-302 supersedes the old DT-007 best-effort multi-write recovery shim. This
// integration test pins the replacement contract at the real PeerLinkService
// boundary: the WAL is the commit point, a failed projection fails closed, a
// fresh service rolls it forward, and the ciphertext is never decrypted twice.

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

async function provisionPeerLinkBinding({ peerLinks, identity }) {
  const issuedAtMs = Date.now();
  const expiresAtMs = issuedAtMs + 7 * 24 * 60 * 60 * 1000;
  const challenge = await peerLinks.getOrCreateAccountBindingChallenge({ ownerAccountId: identity.accountId });
  const payload = {
    kind: "x3dh-subkey-binding",
    accountId: identity.accountId,
    x3dhIdentityPublicKeyB64: challenge.x3dhIdentityPublicKeyB64,
    issuedAtMs,
    expiresAtMs,
  };
  const sig = CRYPTO.sign({ privateKey: identity.privateKey, msg: signedPayloadBytes(payload) });
  await peerLinks.upsertAccountBinding({
    ownerAccountId: identity.accountId,
    accountBinding: {
      ...payload,
      accountIdentityPublicKeyB64: identity.accountIdentityPublicKeyB64,
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
        if (!signerRef || signerRef.accountId !== accountId || signerRef.keyId !== keyId || signerRef.alg !== alg) return false;
        return nodeVerify(null, bytes, publicKeyObj, sigBytes);
      },
    },
  };
}

function makeAuthorityProvider(accounts) {
  const authorities = new Map(accounts.map((account) => [account.accountId, createInviteAuthority(account.accountId)]));
  return (accountId) => authorities.get(accountId);
}

function makeService({ accountId, inboxId, getInviteAuthority, storageProvider = createDefaultStorageProvider() }) {
  return {
    storageProvider,
    svc: new PeerLinkService({
      storageProvider,
      clock: () => Date.now(),
      ownerAccountId: accountId,
      getInviteAuthority,
      inviteBinding: { mailboxId: inboxId, capabilityId: inboxId },
      cryptoProvider: new NodeCryptoProvider(),
    }),
  };
}

async function makeWorld() {
  const alice = createSessionIdentity();
  const bob = createSessionIdentity();
  const getInviteAuthority = makeAuthorityProvider([alice, bob]);
  const a = makeService({ accountId: alice.accountId, inboxId: "inbox:dt302:a", getInviteAuthority });
  const b = makeService({ accountId: bob.accountId, inboxId: "inbox:dt302:b", getInviteAuthority });
  await provisionPeerLinkBinding({ peerLinks: a.svc, identity: alice });
  await provisionPeerLinkBinding({ peerLinks: b.svc, identity: bob });

  const invite = await a.svc.createInvite({ ownerAccountId: alice.accountId, maxUses: 1, expiresAtMs: Date.now() + 60_000 });
  const envelope = await a.svc.getStoredInviteEnvelope(alice.accountId, invite.inviteId);
  let handshakePacket = null;
  await b.svc.acceptInvite({
    envelope: envelope.envelope,
    signatureB64: envelope.signatureB64,
    acceptorAccountId: bob.accountId,
    senderInboxId: "inbox:dt302:b",
    sendHandshake: async ({ handshakePacket: packet }) => {
      handshakePacket = packet;
      return { packetId: "test:hs:dt302" };
    },
  });
  await a.svc.handleIncomingHandshakePacket({
    ownerAccountId: alice.accountId,
    packetBytes: handshakePacket.toBytes(),
  });
  return { alice, bob, getInviteAuthority, a, b };
}

test("DT-302: a committed receive survives a projection crash and rolls forward exactly once", async () => {
  const { alice, bob, getInviteAuthority, a, b } = await makeWorld();
  const plaintext = new TextEncoder().encode("durable after the commit point");
  const encrypted = await a.svc.encryptDirectMessage({
    ownerAccountId: alice.accountId,
    peerAccountId: bob.accountId,
    plaintextBytes: plaintext,
  });

  const kv = b.storageProvider.getKeyValueStore(null);
  const originalSet = kv.set.bind(kv);
  let projectionFailures = 0;
  kv.set = function failSessionProjection(key, value) {
    if (key.startsWith("peer-link:sessions:") && !key.startsWith("peer-link:sessions:by-peer-link:")) {
      projectionFailures += 1;
      throw new Error("injected projection crash");
    }
    return originalSet(key, value);
  };

  await assert.rejects(
    () => b.svc.decryptDirectMessageAnyPeer({
      ownerAccountId: bob.accountId,
      packetBytes: encrypted.encryptedPacket.toBytes(),
      deliveryContext: { mailboxId: "inbox:dt302:b", eventId: "evt:dt302" },
    }),
    (err) => err && err.code === "DELIVERY_COMMIT_FATAL" && err.scope === "lane",
  );
  assert.ok(projectionFailures >= 2, "bounded projection retries were exhausted");
  assert.equal((await kv.keys(DELIVERY_COMMIT_PREFIX)).length, 1, "the durable commit remains recoverable");
  kv.set = originalSet;
  await b.svc.close();

  const restarted = makeService({
    accountId: bob.accountId,
    inboxId: "inbox:dt302:b",
    getInviteAuthority,
    storageProvider: b.storageProvider,
  }).svc;
  const pending = await restarted.listPendingDeliveryWork(bob.accountId);
  assert.equal(pending.length, 1);
  assert.equal(new TextDecoder().decode(Buffer.from(pending[0].plaintextB64, "base64")), new TextDecoder().decode(plaintext));
  assert.equal((await kv.keys(DELIVERY_COMMIT_PREFIX)).length, 0, "startup recovery compacted the WAL");

  const duplicate = await restarted.decryptDirectMessageAnyPeer({
    ownerAccountId: bob.accountId,
    packetBytes: encrypted.encryptedPacket.toBytes(),
  });
  assert.equal(duplicate.deliveryDuplicate, true);
  assert.equal(duplicate.deliveryWork.sealedDigest, pending[0].sealedDigest);

  await restarted.markDeliveryWorkApplied({
    ownerAccountId: bob.accountId,
    sealedDigest: pending[0].sealedDigest,
  });
  const appliedDuplicate = await restarted.decryptDirectMessageAnyPeer({
    ownerAccountId: bob.accountId,
    packetBytes: encrypted.encryptedPacket.toBytes(),
  });
  assert.equal(appliedDuplicate.deliveryDuplicate, true);
  assert.equal(appliedDuplicate.deliveryWork, null);
});

test("DT-302: simultaneous duplicate delivery decrypts once and converges on one work record", async () => {
  const { alice, bob, a, b } = await makeWorld();
  const plaintext = new TextEncoder().encode("one ciphertext, one ratchet advance");
  const encrypted = await a.svc.encryptDirectMessage({
    ownerAccountId: alice.accountId,
    peerAccountId: bob.accountId,
    plaintextBytes: plaintext,
  });
  const packetBytes = encrypted.encryptedPacket.toBytes();
  const [left, right] = await Promise.all([
    b.svc.decryptDirectMessageAnyPeer({
      ownerAccountId: bob.accountId,
      packetBytes,
      deliveryContext: { mailboxId: "inbox:dt302:b", eventId: "evt:duplicate:left" },
    }),
    b.svc.decryptDirectMessageAnyPeer({
      ownerAccountId: bob.accountId,
      packetBytes,
      deliveryContext: { mailboxId: "inbox:dt302:b", eventId: "evt:duplicate:right" },
    }),
  ]);

  assert.ok(left.deliveryWork);
  assert.ok(right.deliveryWork);
  assert.equal(left.deliveryWork.sealedDigest, right.deliveryWork.sealedDigest);
  assert.equal([left, right].filter((result) => result.deliveryDuplicate === true).length, 1);
  const pending = await b.svc.listPendingDeliveryWork(bob.accountId);
  assert.equal(pending.length, 1);
  assert.equal(new TextDecoder().decode(Buffer.from(pending[0].plaintextB64, "base64")), new TextDecoder().decode(plaintext));
});

test("audit N4: pruning an applied marker cannot replay plaintext or break the next ratchet message", async () => {
  const { alice, bob, a, b } = await makeWorld();
  const send = (text) => a.svc.encryptDirectMessage({
    ownerAccountId: alice.accountId, peerAccountId: bob.accountId,
    plaintextBytes: new TextEncoder().encode(text),
  });
  const first = await send("apply exactly once");
  const packetBytes = first.encryptedPacket.toBytes();
  const received = await b.svc.decryptDirectMessageAnyPeer({ ownerAccountId: bob.accountId, packetBytes });
  await b.svc.markDeliveryWorkApplied({ ownerAccountId: bob.accountId, sealedDigest: received.deliveryWork.sealedDigest });
  const store = new DeliveryCommitStore({ keyValueStore: b.storageProvider.getKeyValueStore(null), runtimeEpoch: 1 });
  assert.equal(await store.pruneAppliedReplay(bob.accountId, { maxRecords: 0 }), 1);
  await assert.rejects(b.svc.decryptDirectMessageAnyPeer({ ownerAccountId: bob.accountId, packetBytes }));
  assert.deepEqual(await b.svc.listPendingDeliveryWork(bob.accountId), []);
  const next = await send("next legitimate message");
  const result = await b.svc.decryptDirectMessageAnyPeer({ ownerAccountId: bob.accountId, packetBytes: next.encryptedPacket.toBytes() });
  assert.equal(new TextDecoder().decode(result.plaintextBytes), "next legitimate message");
});
