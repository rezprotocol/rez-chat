import test from "node:test";
import assert from "node:assert/strict";
import { bytesToBase64, deriveAccountIdFromPublicKey, DeviceRegistrationV1 } from "@rezprotocol/core";
import { PeerLinkService, createKeyValueBackedPeerLinkStorage } from "@rezprotocol/sdk/peer-link";
import { NodeCryptoProvider } from "@rezprotocol/node";
import { ServerAccountMutationService } from "../src/server/services/ServerAccountMutationService.js";

// S2.5 S11 L13 — the chat-side driver for serialized device mutations + revocation
// propagation, proven through the SERVICE with REAL peer-link crypto
// (NodeCryptoProvider) and a shared in-memory durable-records overlay. The HOME
// (sdk.devices/identity) is stubbed — the serializer + authz are proven in
// rez-node (L6/L7); here we prove the propagation (republish at the new revision +
// publish the authority-state record) and the reader-side revocation consult.
const CRYPTO = new NodeCryptoProvider();
const enc = (s) => new TextEncoder().encode(s);
const FAR_FUTURE = 10_000_000_000_000;
// AccountAuthorityStateV1 validates CANONICAL cert ids (rez:cap:<64-hex>). Earlier fixtures used
// shorthand like REVOKED_CERT, which the record rejected — the test was red for that reason
// alone, not for the behavior it describes.
const REVOKED_CERT = "rez:cap:" + "e".repeat(64);
const OTHER_CERT = "rez:cap:" + "d".repeat(64);

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

function makeOverlay() {
  const m = new Map();
  const key = (pub, kind, id) => `${pub}|${kind}:${id}`;
  const double = () => ({
    async put({ record }) {
      const j = record && typeof record.toJSON === "function" ? record.toJSON() : JSON.parse(JSON.stringify(record));
      m.set(key(j.ownerPublicKeyB64, j.recordKind, j.recordId), j);
    },
    async get({ recordKind, recordId, publisherPublicKeyB64 }) {
      const v = m.get(key(publisherPublicKeyB64, recordKind, recordId));
      return v ? JSON.parse(JSON.stringify(v)) : null;
    },
  });
  return { map: m, double };
}

function makeBus(runtime, { onDrain = null } = {}) {
  const invalidations = [];
  // Every propagation step in call-order, so a test can prove the authority-state publication
  // happens BEFORE the per-peer republish (the P1#3 ordering fix).
  const order = [];
  return {
    runtime, services: {}, stores: {}, invalidations, order,
    on() { return () => {}; },
    emit() {},
    registerFunction() {},
    call(namespace, name, payload) {
      if (namespace === "device-set" && name === "invalidate") {
        order.push("invalidate:" + (payload && payload.peerAccountId));
        invalidations.push(payload && payload.peerAccountId);
      }
      // P1#3 leaf 5c: the authority-state record is no longer built + put here — the service
      // drains the home's durable obligation through this directive instead.
      if (namespace === "authority-publication" && name === "drain") {
        order.push("drain");
        return Promise.resolve(
          onDrain ? onDrain() : { enabled: true, cycles: 1, publishedEpochs: [], stopped: "nothing-pending" },
        );
      }
      return Promise.resolve(null);
    },
  };
}

// A stubbed home: getAuthorityState feeds the expectedRevision; submitDeviceMutation
// returns a scripted serializer result. buildAccountDeviceMutation is opaque (the
// real one is proven in rez-sdk L9); the stub result is what drives propagation.
function makeHome({ authorityEpoch = 0, submit } = {}) {
  const calls = { getAuthorityState: 0, submit: 0, built: [] };
  return {
    calls,
    devices: {
      async getAuthorityState() { calls.getAuthorityState += 1; return { epoch: authorityEpoch, revokedCertIds: [], minValidIssuedAtMs: 0 }; },
      async submitDeviceMutation({ mutation }) { calls.submit += 1; return submit(mutation, calls.submit); },
    },
    identity: {
      async buildAccountDeviceMutation(params) { calls.built.push(params); return { opaque: true, ...params }; },
    },
  };
}

function makeMutationService(account, overlay, home, { clock, onDrain = null } = {}) {
  const bus = makeBus(
    { peerLinks: account.svc, sdk: { durableRecords: overlay.double(), devices: home.devices, identity: home.identity } },
    { onDrain },
  );
  const svc = new ServerAccountMutationService({ bus, ownerAccountId: account.accountId, clock: clock || (() => 1000) });
  return { svc, bus };
}

test("submit → propagate: publishes authority state FIRST, then republishes the device set to EVERY peer", async () => {
  const overlay = makeOverlay();
  const alice = await makeAccount({ mailboxId: "rez:inbox:alice" });
  const bob = await makeAccount({ mailboxId: "rez:inbox:bob" });
  const carol = await makeAccount({ mailboxId: "rez:inbox:carol" });
  await crossLink(alice, bob, { aLinkId: "pl_a_b", bLinkId: "pl_b_a" });
  await crossLink(alice, carol, { aLinkId: "pl_a_c", bLinkId: "pl_c_a" });

  const home = makeHome({
    authorityEpoch: 1,
    submit: () => ({ revision: 2, devices: [], authorityState: { epoch: 2, revokedCertIds: [REVOKED_CERT], minValidIssuedAtMs: 0 } }),
  });
  // Stands in for ServerAuthorityPublicationService draining the home's durable obligation: it
  // builds + publishes exactly the record the worker would. The worker's own lease protocol is
  // proven in server.authority-publication.service.test.js.
  const onDrain = async () => {
    const rec = await alice.svc.buildAccountAuthorityStateRecord({
      epoch: 2, revokedCertIds: [REVOKED_CERT], minValidIssuedAtMs: 0, nowMs: 5000,
    });
    await overlay.double().put({ record: rec.record });
    return { enabled: true, cycles: 1, publishedEpochs: [2], stopped: "nothing-pending" };
  };
  const { svc, bus } = makeMutationService(alice, overlay, home, { clock: () => 5000, onDrain });

  const result = await svc.submitMutation({ action: "device.revoke", target: { revokedDeviceId: "rez:dev:gone" } });
  assert.equal(result.revision, 2);
  assert.equal(home.calls.built[0].expectedRevision, 1, "expectedRevision read from the home epoch");

  // P1#3: the revocation record — the only thing OFF-home peers can read — is published BEFORE
  // the best-effort per-peer republish, so a peer write failure can no longer preempt it.
  assert.equal(bus.order[0], "drain", "authority state is discharged first");
  assert.equal(bus.order.filter((o) => o === "drain").length, 1, "drained once per mutation");

  // 2 device-set records (alice→bob, alice→carol) + 1 authority-state record from the drain.
  assert.equal(overlay.map.size, 3, "republished to both peers + published authority state");
  // Both peers' caches were dropped so they re-ingest the new revision.
  assert.deepEqual([...bus.invalidations].sort(), [bob.accountId, carol.accountId].sort());

  // Bob ingests the republished set → it carries the NEW revision 2.
  const built = await alice.svc.buildDeviceSetRecordForPeer({ peerAccountId: bob.accountId, revision: 2, nowMs: 5000 });
  const okBob = await bob.svc.ingestPeerDeviceSet({ peerAccountId: alice.accountId, record: built.record, nowMs: 5000 });
  assert.equal(okBob.revision, 2, "the republished set is at the new authority revision");

  // The authority-state record bob reads carries the revoked cert.
  const bobSvc = makeMutationService(bob, overlay, home, { clock: () => 6000 }).svc;
  const rev = await bobSvc.getPeerRevocationState({ peerAccountId: alice.accountId });
  assert.ok(rev && rev.revokedCertIds.includes(REVOKED_CERT), "peer reads the published revocation");
});

test("a failed authority-state drain does NOT fail the committed mutation", async () => {
  // The mutation has COMMITTED at the home and the obligation is durable. Reporting failure to
  // the caller would say a committed revocation did not happen — false, and exactly the
  // misreporting shape the P1#2 audit flagged. It is logged and retried instead.
  const overlay = makeOverlay();
  const alice = await makeAccount({ mailboxId: "rez:inbox:alice" });
  const bob = await makeAccount({ mailboxId: "rez:inbox:bob" });
  await crossLink(alice, bob, { aLinkId: "pl_a_b", bLinkId: "pl_b_a" });

  const home = makeHome({
    authorityEpoch: 1,
    submit: () => ({ revision: 2, devices: [], authorityState: { epoch: 2, revokedCertIds: [REVOKED_CERT], minValidIssuedAtMs: 0 } }),
  });
  const onDrain = async () => { throw new Error("home unreachable"); };
  const { svc, bus } = makeMutationService(alice, overlay, home, { clock: () => 5000, onDrain });
  const logged = [];
  svc.logger = { ...console, error: (m) => logged.push(m), info: () => {}, warn: () => {} };

  const result = await svc.submitMutation({ action: "device.revoke", target: { revokedDeviceId: "rez:dev:gone" } });

  assert.equal(result.revision, 2, "the committed mutation is still reported as committed");
  assert.ok(logged.some((m) => m.includes("authority-state publication FAILED")), "but the failure is loud");
  // The per-peer republish still ran: a publication failure must not cascade into skipping it.
  assert.deepEqual(bus.invalidations, [bob.accountId]);
});

test("an unreachable outbox after a COMMITTED mutation is escalated as contradictory wiring", async () => {
  // A mutation can only commit if the home enqueued its obligation — the serializer builds or
  // validates a propagation outbox in its constructor. So "no outbox" here is not a deployment
  // shape, it is broken wiring, and it means revocations stop reaching off-home peers.
  const overlay = makeOverlay();
  const alice = await makeAccount({ mailboxId: "rez:inbox:alice" });
  const home = makeHome({
    authorityEpoch: 1,
    submit: () => ({ revision: 2, devices: [], authorityState: { epoch: 2, revokedCertIds: [], minValidIssuedAtMs: 0 } }),
  });
  const onDrain = async () => ({ enabled: true, cycles: 1, publishedEpochs: [], stopped: "outbox-unavailable" });
  const { svc } = makeMutationService(alice, overlay, home, { clock: () => 5000, onDrain });
  const logged = [];
  svc.logger = { ...console, error: (m) => logged.push(m), info: () => {}, warn: () => {} };

  await svc.submitMutation({ action: "device.revoke", target: { revokedDeviceId: "rez:dev:gone" } });
  assert.ok(logged.some((m) => m.includes("outbox is unreachable") && m.includes("NOT reach off-home peers")));
});

test("submit retries on a stale expectedRevision, then converges", async () => {
  const overlay = makeOverlay();
  const alice = await makeAccount({ mailboxId: "rez:inbox:alice" });
  const bob = await makeAccount({ mailboxId: "rez:inbox:bob" });
  await crossLink(alice, bob, { aLinkId: "pl_a_b", bLinkId: "pl_b_a" });

  const home = makeHome({
    authorityEpoch: 0,
    submit: (mutation, n) => (n < 2
      ? { stale: true, currentRevision: n, devices: [], authorityState: { epoch: n, revokedCertIds: [], minValidIssuedAtMs: 0 } }
      : { revision: 3, devices: [], authorityState: { epoch: 3, revokedCertIds: [], minValidIssuedAtMs: 0 } }),
  });
  const { svc } = makeMutationService(alice, overlay, home);
  const result = await svc.submitMutation({ action: "device.add", target: { deviceInboxBinding: {} } });
  assert.equal(result.revision, 3);
  assert.equal(home.calls.submit, 2, "retried once past the stale response");
});

test("submit throws when the home never converges (always stale)", async () => {
  const overlay = makeOverlay();
  const alice = await makeAccount({ mailboxId: "rez:inbox:alice" });
  const home = makeHome({ authorityEpoch: 0, submit: (m, n) => ({ stale: true, currentRevision: n, devices: [], authorityState: { epoch: n, revokedCertIds: [], minValidIssuedAtMs: 0 } }) });
  const { svc } = makeMutationService(alice, overlay, home);
  await assert.rejects(() => svc.submitMutation({ action: "device.add", target: { deviceInboxBinding: {} } }), /could not converge/);
});

test("getPeerRevocationState returns null when the peer has published no revocations (byte-compat)", async () => {
  const overlay = makeOverlay();
  const alice = await makeAccount({ mailboxId: "rez:inbox:alice" });
  const bob = await makeAccount({ mailboxId: "rez:inbox:bob" });
  await crossLink(alice, bob, { aLinkId: "pl_a_b", bLinkId: "pl_b_a" });

  // Alice publishes an EMPTY authority state (epoch 1, no revocations).
  const rec = await alice.svc.buildAccountAuthorityStateRecord({ epoch: 1, revokedCertIds: [], nowMs: 100 });
  await overlay.double().put({ record: rec.record });

  const home = makeHome({});
  const { svc } = makeMutationService(bob, overlay, home);
  const rev = await svc.getPeerRevocationState({ peerAccountId: alice.accountId });
  assert.equal(rev, null, "empty authority state ⇒ null revocationState (primary path)");
});

test("getPeerRevocationState is bounded-staleness cached (second call does not re-fetch)", async () => {
  const overlay = makeOverlay();
  const alice = await makeAccount({ mailboxId: "rez:inbox:alice" });
  const bob = await makeAccount({ mailboxId: "rez:inbox:bob" });
  await crossLink(alice, bob, { aLinkId: "pl_a_b", bLinkId: "pl_b_a" });
  const rec = await alice.svc.buildAccountAuthorityStateRecord({ epoch: 2, revokedCertIds: [OTHER_CERT], nowMs: 100 });
  await overlay.double().put({ record: rec.record });

  let gets = 0;
  const base = overlay.double();
  const counting = { put: base.put, get: async (q) => { gets += 1; return base.get(q); } };
  const bus = makeBus({ peerLinks: bob.svc, sdk: { durableRecords: counting, devices: {}, identity: {} } });
  // isEnabled needs devices+identity present; supply minimal truthy stubs.
  bus.runtime.sdk.devices = { async getAuthorityState() { return { epoch: 0 }; } };
  bus.runtime.sdk.identity = {};
  const svc = new ServerAccountMutationService({ bus, ownerAccountId: bob.accountId, clock: () => 1000 });

  const first = await svc.getPeerRevocationState({ peerAccountId: alice.accountId });
  const second = await svc.getPeerRevocationState({ peerAccountId: alice.accountId });
  assert.equal(gets, 1, "second call served from cache");
  assert.deepEqual(second, first);
  assert.ok(first.revokedCertIds.includes(OTHER_CERT));
});

test("account-mutation service is a no-op when this account runs no per-device sessions", async () => {
  const overlay = makeOverlay();
  const noDevice = await makeAccount({ mailboxId: "rez:inbox:legacy", withDevice: false });
  const home = makeHome({});
  const { svc } = makeMutationService(noDevice, overlay, home);
  assert.equal(svc.isEnabled(), false);
  assert.equal(await svc.submitMutation({ action: "device.add", target: {} }), null);
  assert.equal(await svc.getPeerRevocationState({ peerAccountId: "rez:acct:x" }), null);
  assert.equal(overlay.map.size, 0);
});
