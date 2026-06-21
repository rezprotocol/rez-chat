import test from "node:test";
import assert from "node:assert/strict";
import { bytesToBase64, deriveAccountIdFromPublicKey, DeviceRegistrationV1 } from "@rezprotocol/core";
import { PeerLinkService, createKeyValueBackedPeerLinkStorage } from "@rezprotocol/sdk/peer-link";
import { NodeCryptoProvider } from "@rezprotocol/node";
import { ServerDeviceSetService } from "../src/server/services/ServerDeviceSetService.js";

// S2.5 Slice 5 leaf 1 — the chat-side device-set wiring proven END TO END through
// the SERVICE with REAL crypto (NodeCryptoProvider: real X25519/Ed25519/AES-GCM):
// Alice publishes her device set to a shared durable-records double, Bob resolves
// + ingests it (establishing a per-device session), Alice completes her responder
// session, and a per-device message round-trips both ways over the sessions the
// service wired.
const CRYPTO = new NodeCryptoProvider();
const enc = (s) => new TextEncoder().encode(s);
const dec = (b) => new TextDecoder().decode(b);
const FAR_FUTURE = 10_000_000_000_000;

function makeKvStore() {
  const m = new Map();
  return {
    async get(k) { return m.has(k) ? m.get(k) : undefined; },
    async set(k, v) { m.set(k, v); },
    async delete(k) { return m.delete(k); },
    async keys(prefix) {
      const out = [];
      for (const k of m.keys()) if (!prefix || k.startsWith(prefix)) out.push(k);
      return out;
    },
  };
}

function makeStorageProvider() {
  const kv = makeKvStore();
  const peerLinkStorage = createKeyValueBackedPeerLinkStorage({ keyValueStore: kv });
  return { getPeerLinkStorage() { return peerLinkStorage; }, getKeyValueStore() { return kv; }, peerLinkStorage };
}

async function makeDeviceKey() {
  const kp = await CRYPTO.generateSigningKeyPair();
  return { publicKeyB64: bytesToBase64(kp.publicKey), privateKeyB64: bytesToBase64(kp.privateKey) };
}

// A real account: Ed25519 B (chat-server identity) key, an invite authority that
// signs with it + exposes signerPublicKeyB64 (what production wires), a device key
// C, a self-provisioned account binding, and a PeerLinkService running per-device
// sessions.
async function makeAccount({ mailboxId, withDevice = true } = {}) {
  const b = await CRYPTO.generateSigningKeyPair();
  const accountPubB64 = bytesToBase64(b.publicKey);
  const accountId = deriveAccountIdFromPublicKey(b.publicKey);
  const authority = {
    signer: {
      getSignerRef() { return { accountId, keyId: "invite-ed25519-v1", alg: "ed25519", signerPublicKeyB64: accountPubB64 }; },
      async sign(bytes) { return CRYPTO.sign({ privateKey: b.privateKey, msg: bytes }); },
    },
    verifier: { async verify() { return true; } },
  };
  const deviceKeyPair = withDevice ? await makeDeviceKey() : null;
  const sp = makeStorageProvider();
  const svc = new PeerLinkService({
    storageProvider: sp,
    clock: () => 1,
    ownerAccountId: accountId,
    getInviteAuthority: () => authority,
    inviteBinding: { mailboxId, capabilityId: mailboxId },
    cryptoProvider: CRYPTO,
    deviceKeyPair: deviceKeyPair ? deviceKeyPair : null,
    deviceId: deviceKeyPair ? DeviceRegistrationV1.deviceIdFor(deviceKeyPair.publicKeyB64) : null,
  });

  const challenge = await svc.getOrCreateAccountBindingChallenge({ ownerAccountId: accountId });
  const bindingSig = await CRYPTO.sign({ privateKey: b.privateKey, msg: enc("x3dh-subkey-binding:" + challenge.x3dhIdentityPublicKeyB64) });
  await svc.upsertAccountBinding({
    ownerAccountId: accountId,
    accountBinding: {
      accountId,
      accountIdentityPublicKeyB64: accountPubB64,
      x3dhIdentityPublicKeyB64: challenge.x3dhIdentityPublicKeyB64,
      issuedAtMs: 1,
      expiresAtMs: FAR_FUTURE,
      accountBindingSigB64: bytesToBase64(bindingSig),
    },
  });
  const bound = await svc._requireBoundX3dhIdentity(accountId);
  return {
    svc, sp, accountId, accountPubB64,
    deviceId: svc.deviceId,
    identityDhPubB64: bound ? bytesToBase64(bound.identityDhKeyPair.publicKey) : "",
  };
}

async function crossLink(a, b, { aLinkId, bLinkId }) {
  await a.sp.peerLinkStorage.peerLinks.create({
    peerLinkId: aLinkId, localAccountId: a.accountId, peerAccountId: b.accountId,
    state: "session_established",
    remoteIdentityDhPublicKeyB64: b.identityDhPubB64,
    remoteAccountIdentityPublicKeyB64: b.accountPubB64,
    version: 1,
  });
  await b.sp.peerLinkStorage.peerLinks.create({
    peerLinkId: bLinkId, localAccountId: b.accountId, peerAccountId: a.accountId,
    state: "session_established",
    remoteIdentityDhPublicKeyB64: a.identityDhPubB64,
    remoteAccountIdentityPublicKeyB64: a.accountPubB64,
    version: 1,
  });
}

// Shared in-memory durable-records overlay. Faithful: records round-trip through
// JSON (as they would over the wire via record.put/get).
function makeOverlay() {
  const m = new Map();
  const key = (pub, kind, id) => `${pub}|${kind}:${id}`;
  const double = () => ({
    async put({ record }) {
      const j = record && typeof record.toJSON === "function" ? record.toJSON() : JSON.parse(JSON.stringify(record));
      m.set(key(j.publisherPublicKeyB64, j.recordKind, j.recordId), j);
    },
    async get({ recordKind, recordId, publisherPublicKeyB64 }) {
      const v = m.get(key(publisherPublicKeyB64, recordKind, recordId));
      return v ? JSON.parse(JSON.stringify(v)) : null;
    },
  });
  return { map: m, double };
}

function makeBus(runtime) {
  return {
    runtime, services: {}, stores: {},
    on() { return () => {}; },
    emit() {},
    registerFunction() {},
    call() { return Promise.resolve(null); },
  };
}

function makeService(account, overlay) {
  const bus = makeBus({ peerLinks: account.svc, sdk: { durableRecords: overlay.double() } });
  return new ServerDeviceSetService({ bus, ownerAccountId: account.accountId });
}

test("device-set service: publish → resolve → responder-complete → per-device round-trip both ways", async () => {
  const overlay = makeOverlay();
  const alice = await makeAccount({ mailboxId: "rez:inbox:alice" });
  const bob = await makeAccount({ mailboxId: "rez:inbox:bob" });
  await crossLink(alice, bob, { aLinkId: "pl_alice_bob", bLinkId: "pl_bob_alice" });

  const aliceDeviceSet = makeService(alice, overlay);
  const bobDeviceSet = makeService(bob, overlay);

  // Alice publishes her set (retains her responder pre-key keyed by Bob). The
  // record lands on the shared overlay at the peer-derived slot.
  const published = await aliceDeviceSet.publishForPeer({ peerAccountId: bob.accountId });
  assert.ok(published && published.recordId, "publish returned coordinates");
  assert.equal(overlay.map.size, 1, "the sealed device-set record is on the overlay");

  // Bob resolves Alice's set: fetch + ingest → establishes a session to Alice's device.
  const resolved = await bobDeviceSet.resolveForPeer({ peerAccountId: alice.accountId });
  assert.ok(resolved, "Bob resolved Alice's device set");
  assert.equal(resolved.deviceSetRecord.devices.length, 1);
  assert.equal(resolved.established.length, 1);
  assert.equal(resolved.established[0].peerDeviceId, alice.deviceId);

  // Alice completes her responder session to Bob's device from Bob's handshake.
  await aliceDeviceSet.completeResponder({
    peerAccountId: bob.accountId,
    peerDeviceId: bob.deviceId,
    handshakeData: resolved.established[0].handshakeData,
  });

  // Bob → Alice over the established per-device session.
  const { encryptedPacket: toAlice } = await bob.svc.encryptDirectMessageForDevice({
    peerAccountId: alice.accountId, peerLinkId: "pl_bob_alice", peerDeviceId: alice.deviceId, plaintextBytes: enc("hi alice"),
  });
  const gotAlice = await alice.svc.decryptFromDevice({
    peerAccountId: bob.accountId, peerLinkId: "pl_alice_bob", peerDeviceId: bob.deviceId, packetBytes: toAlice.toBytes(),
  });
  assert.equal(dec(gotAlice.plaintextBytes), "hi alice");

  // Alice → Bob over the same session pair.
  const { encryptedPacket: toBob } = await alice.svc.encryptDirectMessageForDevice({
    peerAccountId: bob.accountId, peerLinkId: "pl_alice_bob", peerDeviceId: bob.deviceId, plaintextBytes: enc("hi bob"),
  });
  const gotBob = await bob.svc.decryptFromDevice({
    peerAccountId: alice.accountId, peerLinkId: "pl_bob_alice", peerDeviceId: alice.deviceId, packetBytes: toBob.toBytes(),
  });
  assert.equal(dec(gotBob.plaintextBytes), "hi bob");
});

test("device-set service: resolveForPeer caches — a second call does not re-fetch / re-ingest", async () => {
  const overlay = makeOverlay();
  const alice = await makeAccount({ mailboxId: "rez:inbox:alice" });
  const bob = await makeAccount({ mailboxId: "rez:inbox:bob" });
  await crossLink(alice, bob, { aLinkId: "pl_alice_bob", bLinkId: "pl_bob_alice" });
  await makeService(alice, overlay).publishForPeer({ peerAccountId: bob.accountId });

  // Count overlay gets via a wrapping double.
  let gets = 0;
  const base = overlay.double();
  const counting = { put: base.put, get: async (q) => { gets += 1; return base.get(q); } };
  const bobDeviceSet = new ServerDeviceSetService({
    bus: makeBus({ peerLinks: bob.svc, sdk: { durableRecords: counting } }),
    ownerAccountId: bob.accountId,
  });

  const first = await bobDeviceSet.resolveForPeer({ peerAccountId: alice.accountId });
  const second = await bobDeviceSet.resolveForPeer({ peerAccountId: alice.accountId });
  assert.equal(gets, 1, "second resolve served from cache (no re-fetch)");
  assert.equal(second, first, "same cached object");
});

test("device-set service: resolveForPeer returns null when the peer has published nothing", async () => {
  const overlay = makeOverlay();
  const alice = await makeAccount({ mailboxId: "rez:inbox:alice" });
  const bob = await makeAccount({ mailboxId: "rez:inbox:bob" });
  await crossLink(alice, bob, { aLinkId: "pl_alice_bob", bLinkId: "pl_bob_alice" });
  // Bob resolves before Alice ever published.
  const resolved = await makeService(bob, overlay).resolveForPeer({ peerAccountId: alice.accountId });
  assert.equal(resolved, null);
});

test("device-set service is a no-op when this account runs no per-device sessions (no device key)", async () => {
  const overlay = makeOverlay();
  const noDevice = await makeAccount({ mailboxId: "rez:inbox:legacy", withDevice: false });
  const svc = makeService(noDevice, overlay);
  assert.equal(svc.isEnabled(), false);
  assert.equal(await svc.publishForPeer({ peerAccountId: "rez:acct:whatever" }), null);
  assert.equal(await svc.resolveForPeer({ peerAccountId: "rez:acct:whatever" }), null);
  assert.equal(overlay.map.size, 0, "a disabled service never touches the overlay");
});

test("Audit R2 #2: a re-PUBLISHED (re-sealed, same revision) set does NOT reset the session after the cache TTL", async () => {
  const overlay = makeOverlay();
  const alice = await makeAccount({ mailboxId: "rez:inbox:alice" });
  const bob = await makeAccount({ mailboxId: "rez:inbox:bob" });
  await crossLink(alice, bob, { aLinkId: "pl_alice_bob", bLinkId: "pl_bob_alice" });
  // Alice publishes on the SAME synthetic clock Bob resolves on — otherwise the
  // set's issuedAtMs (real Date.now) would read as far-future against Bob's tiny
  // clock and (correctly, Audit R4 #8) be rejected as future-issued.
  let now = 1000;
  const aliceDeviceSet = new ServerDeviceSetService({
    bus: makeBus({ peerLinks: alice.svc, sdk: { durableRecords: overlay.double() } }),
    ownerAccountId: alice.accountId,
    clock: () => now,
  });
  const bobDeviceSet = new ServerDeviceSetService({
    bus: makeBus({ peerLinks: bob.svc, sdk: { durableRecords: overlay.double() } }),
    ownerAccountId: bob.accountId,
    clock: () => now,
  });

  await aliceDeviceSet.publishForPeer({ peerAccountId: bob.accountId });
  const first = await bobDeviceSet.resolveForPeer({ peerAccountId: alice.accountId });
  assert.equal(first.established.length, 1, "first resolve establishes one device session");
  await aliceDeviceSet.completeResponder({ peerAccountId: bob.accountId, peerDeviceId: bob.deviceId, handshakeData: first.established[0].handshakeData });

  // Advance the ratchet once over the established session.
  const { encryptedPacket: m1 } = await bob.svc.encryptDirectMessageForDevice({ peerAccountId: alice.accountId, peerLinkId: "pl_bob_alice", peerDeviceId: alice.deviceId, plaintextBytes: enc("one") });
  assert.equal(dec((await alice.svc.decryptFromDevice({ peerAccountId: bob.accountId, peerLinkId: "pl_alice_bob", peerDeviceId: bob.deviceId, packetBytes: m1.toBytes() })).plaintextBytes), "one");

  // Alice re-publishes — same devices + same revision, but a FRESH seal nonce, so
  // the sealed ciphertext at the slot is byte-different. The old ciphertext-key
  // compare would treat this as "changed" and re-ingest, resetting Bob's session.
  await aliceDeviceSet.publishForPeer({ peerAccountId: bob.accountId });

  now += 6 * 60 * 1000; // past the 5-minute cache TTL ⇒ Bob re-fetches + re-ingests
  const second = await bobDeviceSet.resolveForPeer({ peerAccountId: alice.accountId });
  assert.equal(second.established.length, 0, "the re-sealed same-revision set establishes nothing (no reset)");
  assert.equal(second.revision, first.revision, "same monotonic revision honored");

  // Bob's session is intact — a follow-up still decrypts on Alice's UNCHANGED
  // responder (this would throw if the session had been reset by the re-ingest).
  const { encryptedPacket: m2 } = await bob.svc.encryptDirectMessageForDevice({ peerAccountId: alice.accountId, peerLinkId: "pl_bob_alice", peerDeviceId: alice.deviceId, plaintextBytes: enc("two") });
  assert.equal(dec((await alice.svc.decryptFromDevice({ peerAccountId: bob.accountId, peerLinkId: "pl_alice_bob", peerDeviceId: bob.deviceId, packetBytes: m2.toBytes() })).plaintextBytes), "two");
});
