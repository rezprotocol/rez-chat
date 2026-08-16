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

// DT-007 regression (risk reduction; fully closed by DT-302). #commitSession
// persists the advanced ratchet BEFORE the peer-link CAS. Before the fix, a
// CAS conflict after a successful decrypt threw out of the decrypt call: the
// caller reported decrypt-failed, the deposit stayed buffered, and every
// retry decrypted against the already-advanced ratchet — permanent silent
// plaintext loss (and the confirm predicate re-fired, appending a duplicate
// session_established lifecycle event per retry). These tests force a REAL
// version conflict (an out-of-band writer bumps the record between the
// service's read and its CAS) and assert the plaintext always survives.

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
  const storageProvider = createDefaultStorageProvider();
  const svc = new PeerLinkService({
    storageProvider,
    clock: () => Date.now(),
    ownerAccountId: accountId,
    getInviteAuthority,
    inviteBinding: { mailboxId: inboxId, capabilityId: inboxId },
    cryptoProvider: new NodeCryptoProvider(),
  });
  return { svc, storageProvider };
}

// Establish up to the point where the INVITEE has sent its handshake and the
// INVITER has processed it — but the ack is never delivered. The invitee's
// link stays un-established (state handshake_sent, session
// pending_remote_confirm), so the invitee's first successful DECRYPT of a
// message from the inviter takes the #commitSession confirm path. That is
// the exact write DT-007 protects.
async function establishToPendingConfirm({ inviter, inviterId, invitee, inviteeId, inviterInbox, inviteeInbox }) {
  const created = await inviter.createInvite({ ownerAccountId: inviterId, maxUses: 1, expiresAtMs: Date.now() + 60_000 });
  const envelope = await inviter.getStoredInviteEnvelope(inviterId, created.inviteId);
  let handshakePacket = null;
  await invitee.acceptInvite({
    envelope: envelope.envelope,
    signatureB64: envelope.signatureB64,
    acceptorAccountId: inviteeId,
    senderInboxId: inviteeInbox,
    sendHandshake: async ({ handshakePacket: hp }) => {
      handshakePacket = hp;
      return { packetId: "test:hs:dt007" };
    },
  });
  await inviter.handleIncomingHandshakePacket({
    ownerAccountId: inviterId,
    packetBytes: handshakePacket.toBytes(),
  });
  // Ack deliberately NOT delivered to the invitee.
}

async function makeWorld() {
  const alice = createSessionIdentity();
  const bob = createSessionIdentity();
  const getInviteAuthority = makeAuthorityProvider([alice.accountId, bob.accountId]);
  const a = makePeerLinkService({ accountId: alice.accountId, inboxId: "inbox:dt007:a", getInviteAuthority });
  const b = makePeerLinkService({ accountId: bob.accountId, inboxId: "inbox:dt007:b", getInviteAuthority });
  await provisionPeerLinkBinding({ peerLinks: a.svc, identity: alice });
  await provisionPeerLinkBinding({ peerLinks: b.svc, identity: bob });
  await establishToPendingConfirm({
    inviter: a.svc, inviterId: alice.accountId, invitee: b.svc, inviteeId: bob.accountId,
    inviterInbox: "inbox:dt007:a", inviteeInbox: "inbox:dt007:b",
  });
  return { alice, bob, a, b };
}

async function bobLinkRecord(b, bobId) {
  const peerLinks = b.storageProvider.getPeerLinkStorage().peerLinks;
  const page = await peerLinks.listByOwner(bobId);
  const rows = Array.isArray(page) ? page : page.items;
  assert.equal(rows.length, 1, "bob has exactly one peer link");
  return rows[0];
}

async function bobEvents(b, bobId, peerLinkId) {
  const events = b.storageProvider.getPeerLinkStorage().events;
  const page = await events.listByPeerLinkId(bobId, peerLinkId, {});
  return page.items;
}

// Install an interceptor on the invitee's peer-link store that simulates a
// concurrent writer: before delegating the service's update, it performs a
// REAL out-of-band update at the current stored version (bumping it), so the
// service's CAS genuinely mismatches. `mode: "once"` interferes only with the
// first call; `mode: "always"` makes every CAS lose.
function installConflictingWriter(b, mode) {
  const peerLinks = b.storageProvider.getPeerLinkStorage().peerLinks;
  const orig = peerLinks.update.bind(peerLinks);
  let fired = 0;
  peerLinks.update = async function conflictingUpdate(record, expectedVersion) {
    if (mode === "always" || fired === 0) {
      fired += 1;
      const stored = await peerLinks.getById(record.localAccountId, record.peerLinkId);
      await orig({ ...stored }, stored.version);
    }
    return orig(record, expectedVersion);
  };
  return {
    restore() { peerLinks.update = orig; },
    fired: () => fired,
  };
}

test("DT-007: a CAS conflict during the confirm-path commit never suppresses the plaintext (retry lands the transition)", async () => {
  const { alice, bob, a, b } = await makeWorld();

  const enc = await a.svc.encryptDirectMessage({
    ownerAccountId: alice.accountId,
    peerAccountId: bob.accountId,
    plaintextBytes: new TextEncoder().encode("survives the CAS race"),
  });

  const interference = installConflictingWriter(b, "once");
  const dec = await b.svc.decryptDirectMessageAnyPeer({
    ownerAccountId: bob.accountId,
    packetBytes: enc.encryptedPacket.toBytes(),
  });
  interference.restore();

  assert.ok(interference.fired() >= 1, "the conflicting writer actually fired");
  assert.equal(new TextDecoder().decode(dec.plaintextBytes), "survives the CAS race");
  assert.equal(dec.commitError, undefined, "the fresh-read retry landed the transition — no degraded marker");
  assert.equal(dec.snapshot.state, "session_established", "retry committed the confirm transition");

  const link = await bobLinkRecord(b, bob.accountId);
  assert.equal(link.state, "session_established");
  const events = await bobEvents(b, bob.accountId, link.peerLinkId);
  const established = events.filter((e) => e.type === "session_established");
  assert.equal(established.length, 1, "exactly one session_established event — no duplicate appends from the failed attempt");

  // The deposit is NOT stuck retrying against an advanced ratchet: the next
  // message decrypts normally (steady state, no event).
  const enc2 = await a.svc.encryptDirectMessage({
    ownerAccountId: alice.accountId,
    peerAccountId: bob.accountId,
    plaintextBytes: new TextEncoder().encode("second"),
  });
  const dec2 = await b.svc.decryptDirectMessageAnyPeer({
    ownerAccountId: bob.accountId,
    packetBytes: enc2.encryptedPacket.toBytes(),
  });
  assert.equal(new TextDecoder().decode(dec2.plaintextBytes), "second");
  assert.equal(dec2.event, null, "steady state after the recovered commit");
});

test("DT-007: when every CAS attempt loses, the plaintext still returns with a typed commitError and the NEXT decrypt converges with one event", async () => {
  const { alice, bob, a, b } = await makeWorld();

  const enc = await a.svc.encryptDirectMessage({
    ownerAccountId: alice.accountId,
    peerAccountId: bob.accountId,
    plaintextBytes: new TextEncoder().encode("degraded but delivered"),
  });

  const interference = installConflictingWriter(b, "always");
  const dec = await b.svc.decryptDirectMessageAnyPeer({
    ownerAccountId: bob.accountId,
    packetBytes: enc.encryptedPacket.toBytes(),
  });
  interference.restore();

  // Plaintext survives even though the transition never landed.
  assert.equal(new TextDecoder().decode(dec.plaintextBytes), "degraded but delivered");
  assert.ok(dec.commitError, "degraded path carries the typed marker");
  assert.equal(dec.commitError.code, "PEER_LINK_COMMIT_FAILED");
  assert.equal(dec.commitError.stage, "peer-link-transition", "owned record names the failed stage");
  assert.equal(typeof dec.commitError.toJSON, "function", "marker is an owned RRecord, not an ad-hoc object");
  assert.match(dec.commitError.message, /version mismatch/);

  let link = await bobLinkRecord(b, bob.accountId);
  assert.notEqual(link.state, "session_established", "transition did not land under sustained interference");
  let events = await bobEvents(b, bob.accountId, link.peerLinkId);
  assert.equal(events.filter((e) => e.type === "session_established").length, 0,
    "no session_established event was appended by the failed attempts");

  // Interference gone: the next message re-runs the confirm path and commits
  // exactly once — the ratchet advanced across BOTH messages, so decrypting
  // proves the deposit never looped against a stale ratchet.
  const enc2 = await a.svc.encryptDirectMessage({
    ownerAccountId: alice.accountId,
    peerAccountId: bob.accountId,
    plaintextBytes: new TextEncoder().encode("now it lands"),
  });
  const dec2 = await b.svc.decryptDirectMessageAnyPeer({
    ownerAccountId: bob.accountId,
    packetBytes: enc2.encryptedPacket.toBytes(),
  });
  assert.equal(new TextDecoder().decode(dec2.plaintextBytes), "now it lands");
  assert.equal(dec2.commitError, undefined);
  assert.equal(dec2.snapshot.state, "session_established");

  link = await bobLinkRecord(b, bob.accountId);
  assert.equal(link.state, "session_established");
  events = await bobEvents(b, bob.accountId, link.peerLinkId);
  assert.equal(events.filter((e) => e.type === "session_established").length, 1,
    "exactly one session_established event across the whole degraded-then-recovered sequence");
});

// ---- Stage-aware persistence proof (rev-2 review of DT-007) ----
// The recovery helper may return plaintext ONLY after verifying the exact
// advanced session snapshot is durable on the canonical record. These three
// tests inject a failure at each commit stage.

test("DT-007 stage: a sessions.put failure (ratchet NOT durable) re-throws — plaintext is never surfaced uncommitted", async () => {
  const { alice, bob, a, b } = await makeWorld();

  const enc = await a.svc.encryptDirectMessage({
    ownerAccountId: alice.accountId,
    peerAccountId: bob.accountId,
    plaintextBytes: new TextEncoder().encode("must not surface"),
  });

  // Fail the session write entirely: the ratchet advance never reaches
  // storage, so the decrypt MUST fail (deposit stays buffered) rather than
  // hand out plaintext whose receive-ratchet state was never proven durable.
  const sessions = b.storageProvider.getPeerLinkStorage().sessions;
  const origPut = sessions.put.bind(sessions);
  let putCalls = 0;
  sessions.put = async function failingPut(record) {
    putCalls += 1;
    const err = new Error("injected session write failure");
    err.code = "INJECTED_SESSION_WRITE";
    throw err;
  };
  await assert.rejects(
    () => b.svc.decryptDirectMessageAnyPeer({ ownerAccountId: bob.accountId, packetBytes: enc.encryptedPacket.toBytes() }),
    (err) => /injected session write failure/.test(err && err.message ? err.message : String(err)),
  );
  assert.ok(putCalls >= 1, "the injected failure actually fired");
  sessions.put = origPut;

  // Nothing was lost: the stored ratchet never advanced, so the SAME packet
  // decrypts cleanly once the storage fault clears.
  const dec = await b.svc.decryptDirectMessageAnyPeer({
    ownerAccountId: bob.accountId,
    packetBytes: enc.encryptedPacket.toBytes(),
  });
  assert.equal(new TextDecoder().decode(dec.plaintextBytes), "must not surface");
  assert.equal(dec.snapshot.state, "session_established");
  const link = await bobLinkRecord(b, bob.accountId);
  const events = await bobEvents(b, bob.accountId, link.peerLinkId);
  assert.equal(events.filter((e) => e.type === "session_established").length, 1);
});

test("DT-007 stage: an event-append failure AFTER the CAS is surfaced as commitError(stage=event-append), never silent", async () => {
  const { alice, bob, a, b } = await makeWorld();

  const enc = await a.svc.encryptDirectMessage({
    ownerAccountId: alice.accountId,
    peerAccountId: bob.accountId,
    plaintextBytes: new TextEncoder().encode("event lost, surfaced"),
  });

  const events = b.storageProvider.getPeerLinkStorage().events;
  const origAppend = events.append.bind(events);
  events.append = async function failingAppend() {
    throw new Error("injected event append failure");
  };
  const dec = await b.svc.decryptDirectMessageAnyPeer({
    ownerAccountId: bob.accountId,
    packetBytes: enc.encryptedPacket.toBytes(),
  });
  events.append = origAppend;

  assert.equal(new TextDecoder().decode(dec.plaintextBytes), "event lost, surfaced");
  assert.ok(dec.commitError, "post-CAS event failure carries the typed marker");
  assert.equal(dec.commitError.stage, "event-append");
  assert.match(dec.commitError.message, /injected event append failure/);
  // The CAS itself landed: the link is established.
  const link = await bobLinkRecord(b, bob.accountId);
  assert.equal(link.state, "session_established");

  // Steady state afterwards — no stuck loop.
  const enc2 = await a.svc.encryptDirectMessage({
    ownerAccountId: alice.accountId, peerAccountId: bob.accountId,
    plaintextBytes: new TextEncoder().encode("after"),
  });
  const dec2 = await b.svc.decryptDirectMessageAnyPeer({
    ownerAccountId: bob.accountId, packetBytes: enc2.encryptedPacket.toBytes(),
  });
  assert.equal(new TextDecoder().decode(dec2.plaintextBytes), "after");
  assert.equal(dec2.commitError, undefined);
});

// KILL POINT (rev-3 review): read-back equality is NOT proof of durability
// after a REJECTED write. FsKeyValueStore can rename the temp file and then
// fail its directory fsync — the record reads back byte-identical, yet it is
// not proven durable and can vanish on power loss. Modelled here by a
// sessions.put that performs the REAL write and then throws. The recovery
// path must NOT upgrade that read-back to "durable": it re-drives a bounded
// identical rewrite, every attempt fails the same way, and the decrypt fails
// closed rather than surfacing plaintext with stage "session-write".
test("DT-007 stage: a write-then-throw sessions.put is NOT durable — bounded rewrite fails and the decrypt fails closed", async () => {
  const { alice, bob, a, b } = await makeWorld();

  const enc = await a.svc.encryptDirectMessage({
    ownerAccountId: alice.accountId,
    peerAccountId: bob.accountId,
    plaintextBytes: new TextEncoder().encode("readable but not durable"),
  });

  const sessions = b.storageProvider.getPeerLinkStorage().sessions;
  const origPut = sessions.put.bind(sessions);
  let putCalls = 0;
  sessions.put = async function writeThenThrow(record) {
    putCalls += 1;
    await origPut(record); // the bytes ARE visible...
    const err = new Error("injected post-write durability failure");
    err.code = "INJECTED_DURABILITY";
    throw err; // ...but the write is REJECTED, so it is not durable.
  };

  await assert.rejects(
    () => b.svc.decryptDirectMessageAnyPeer({ ownerAccountId: bob.accountId, packetBytes: enc.encryptedPacket.toBytes() }),
    (err) => /injected post-write durability failure/.test(err && err.message ? err.message : String(err)),
    "a rejected write must never be upgraded to durable by reading it back",
  );
  // 1 original attempt + SESSION_REWRITE_ATTEMPTS bounded identical rewrites.
  assert.equal(putCalls, 3, "the rewrite is bounded (repo two-retry policy), not unbounded");
  sessions.put = origPut;

  // The state left behind is COHERENT: the store holds the advanced ratchet,
  // so the next message from the peer decrypts and the commit lands. Only the
  // un-staged plaintext of the rejected commit is unrecoverable here — the
  // known DT-302 hole, and the system never reported it as delivered.
  const enc2 = await a.svc.encryptDirectMessage({
    ownerAccountId: alice.accountId,
    peerAccountId: bob.accountId,
    plaintextBytes: new TextEncoder().encode("after the fault clears"),
  });
  const dec2 = await b.svc.decryptDirectMessageAnyPeer({
    ownerAccountId: bob.accountId,
    packetBytes: enc2.encryptedPacket.toBytes(),
  });
  assert.equal(new TextDecoder().decode(dec2.plaintextBytes), "after the fault clears");
  assert.equal(dec2.commitError, undefined);
});

test("DT-007 stage: a transient sessions.put failure is CONFIRMED by the bounded identical rewrite", async () => {
  const { alice, bob, a, b } = await makeWorld();

  const enc = await a.svc.encryptDirectMessage({
    ownerAccountId: alice.accountId,
    peerAccountId: bob.accountId,
    plaintextBytes: new TextEncoder().encode("confirmed by rewrite"),
  });

  // The first put throws WITHOUT writing; the rewrite succeeds. One attempt
  // returning successfully is what upgrades the state to durable — and the
  // rewrite INPUT is byte-identical, so it asserts the same logical ratchet
  // advance rather than a second one (the stored record's `version` does
  // differ: the session store bumps it on every put).
  const sessions = b.storageProvider.getPeerLinkStorage().sessions;
  const origPut = sessions.put.bind(sessions);
  let putCalls = 0;
  sessions.put = async function flakyPut(record) {
    putCalls += 1;
    if (putCalls === 1) {
      const err = new Error("injected transient session write failure");
      err.code = "INJECTED_TRANSIENT";
      throw err;
    }
    return origPut(record);
  };

  const dec = await b.svc.decryptDirectMessageAnyPeer({
    ownerAccountId: bob.accountId,
    packetBytes: enc.encryptedPacket.toBytes(),
  });
  sessions.put = origPut;

  assert.ok(putCalls >= 2, "the rewrite actually ran");
  assert.equal(new TextDecoder().decode(dec.plaintextBytes), "confirmed by rewrite");
  const link = await bobLinkRecord(b, bob.accountId);
  assert.equal(link.state, "session_established", "the confirmed rewrite let the transition land");
  const events = await bobEvents(b, bob.accountId, link.peerLinkId);
  assert.equal(events.filter((e) => e.type === "session_established").length, 1,
    "exactly one session_established event — the rewrite re-asserts one logical ratchet advance");
});

test("DT-007 stage: concurrent-established WITHOUT this decrypt's ratchet re-throws — snapshot verification gates the plaintext", async () => {
  const { alice, bob, a, b } = await makeWorld();

  const enc = await a.svc.encryptDirectMessage({
    ownerAccountId: alice.accountId,
    peerAccountId: bob.accountId,
    plaintextBytes: new TextEncoder().encode("clobbered ratchet"),
  });

  // Simulate a concurrent commit that (a) establishes the peer link and
  // (b) CLOBBERS the session record with a DIFFERENT ratchet snapshot
  // (sessions.put is last-write-wins), all between the service's read and
  // its CAS. The recovery path sees fresh.state === session_established but
  // the read-back verification must detect that the durable snapshot is NOT
  // this decrypt's advance — so the decrypt fails instead of surfacing
  // plaintext whose receive state was overwritten.
  const pl = b.storageProvider.getPeerLinkStorage();
  const origUpdate = pl.peerLinks.update.bind(pl.peerLinks);
  const origPut = pl.sessions.put.bind(pl.sessions);
  let fired = false;
  pl.peerLinks.update = async function clobberingUpdate(record, expectedVersion) {
    if (!fired) {
      fired = true;
      const storedLink = await pl.peerLinks.getById(record.localAccountId, record.peerLinkId);
      const session = await pl.sessions.getByPeerLinkId(record.localAccountId, record.peerLinkId);
      await origPut({ ...session, ratchetSnapshot: { clobbered: true, by: "concurrent-writer" } });
      await origUpdate({ ...storedLink, state: "session_established" }, storedLink.version);
    }
    return origUpdate(record, expectedVersion);
  };

  await assert.rejects(
    () => b.svc.decryptDirectMessageAnyPeer({ ownerAccountId: bob.accountId, packetBytes: enc.encryptedPacket.toBytes() }),
    (err) => /version mismatch/.test(err && err.message ? err.message : String(err)),
    "established-by-concurrent-writer must NOT excuse a missing ratchet advance",
  );
  assert.equal(fired, true, "the clobbering writer actually fired");
  pl.peerLinks.update = origUpdate;
});
