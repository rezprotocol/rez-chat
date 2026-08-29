// P1.3b (plans/MOBILE_PLATFORM_INTEGRATION_PLAN.md — the frozen R3 /
// commit-ordering / no-fallback rulings, 2026-08-26). What this suite pins:
//
//   InboxClaimant roles — the phase-explicit inbox resolution:
//     "enrollment" claims EXACTLY the bootstrap inbox and records no primary;
//     "portable" resolves the claim store's portable primary ONLY, and the
//     halfway state (no portable primary) is a typed ENROLLMENT_INCOMPLETE
//     refusal — NEVER a fallback to the bootstrap inbox.
//
//   PortableInboxEstablisher — mint EXACTLY ONE portable claim (fresh random
//     claimant, fresh close key, generation 1); a crash-restart REUSES it; a
//     provider failure leaves the claim durably reusable and records no
//     lease; the portable primary can never equal the bootstrap inbox.
//
//   The publication seam — the bundle carries the PORTABLE inbox, and a
//     failed establishment makes publication itself impossible (no wire op),
//     so the activation commit stays READY/unpublished and recoverable:
//     "Activation cannot commit until the permanent portable inbox is
//     durably established. There is no bootstrap-inbox fallback."

import test from "node:test";
import assert from "node:assert/strict";

import { NodeCryptoProvider } from "@rezprotocol/node";
import {
  bytesToBase64,
  relayKeyIdForNodePublicKeyB64,
  nodeKeyIdForNodePublicKeyB64,
} from "@rezprotocol/core";

import { InboxClaimant } from "../src/server/inbox/InboxClaimant.js";
import { PortableInboxEstablisher, PORTABLE_PRIMARY_INBOX_KEY } from "../src/server/inbox/PortableInboxEstablisher.js";
import { ServerDeviceSetService } from "../src/server/services/ServerDeviceSetService.js";
import { ServerDeviceActivationService } from "../src/server/services/ServerDeviceActivationService.js";
import { DeviceActivationJournal, ACTIVATION_STATES } from "../src/server/device/DeviceActivationJournal.js";

const CRYPTO = new NodeCryptoProvider();
const silentLogger = { log() {}, info() {}, warn() {}, error() {}, debug() {} };

const PRIMARY_INBOX_KEY = "chat-server:inbox:primary:v1";
const BOOTSTRAP_INBOX = "inbox:" + "a".repeat(24);

function makeKv() {
  const m = new Map();
  return {
    async get(k) { return m.has(k) ? m.get(k) : null; },
    async set(k, v) { m.set(k, JSON.parse(JSON.stringify(v))); },
    async delete(k) { m.delete(k); },
    _raw: m,
  };
}

function makeStorage() {
  const kv = makeKv();
  return { kv, provider: { getKeyValueStore: () => kv } };
}

// A VALID self-certifying node identity triple — createNodeDelegation refuses
// a relay identity that is not derived from the node key (ADR-RELAY-IDENTITY),
// so the fake provider must present real derivations over a real key.
function fakeNodeIdentity() {
  const kp = CRYPTO.generateSigningKeyPair();
  const nodePublicKeyB64 = bytesToBase64(kp.publicKey);
  return {
    nodeKeyId: nodeKeyIdForNodePublicKeyB64(nodePublicKeyB64),
    nodePublicKeyB64,
    relayKeyId: relayKeyIdForNodePublicKeyB64(nodePublicKeyB64),
  };
}

// The portable provider double: a minimal claimant client that either accepts
// the INBOX_CLAIM round-trip or refuses it. Records everything.
function makeProviderDouble({ accept = true } = {}) {
  const nodeIdentity = fakeNodeIdentity();
  const record = { factoryCalls: 0, connects: 0, closes: 0, claims: [] };
  const clientFactory = async ({ claimantIdentity }) => {
    record.factoryCalls += 1;
    record.claimantIdentity = claimantIdentity;
    return {
      async connect() { record.connects += 1; },
      async close() { record.closes += 1; },
      getSessionInfo() { return { ...nodeIdentity, capabilities: {} }; },
      async sendRequest({ body }) {
        record.claims.push(body);
        if (!accept) {
          const err = new Error("portable provider refused/unreachable");
          err.code = "PROVIDER_DOWN";
          throw err;
        }
        return {};
      },
    };
  };
  return { clientFactory, record };
}

function makeEstablisher({ storage, clientFactory, bootstrapInboxId = BOOTSTRAP_INBOX, clock = () => 1_000 } = {}) {
  return new PortableInboxEstablisher({
    storageProvider: storage.provider,
    cryptoProvider: CRYPTO,
    uplinks: ["ws://portable.example/ws"],
    wsFactory: () => ({}),
    bootstrapInboxId,
    clock,
    clientFactory,
    logger: silentLogger,
  });
}

// ---- InboxClaimant roles ----

test("enrollment role: claims EXACTLY the bootstrap inbox, records NO primary pointer, and a rerun reuses the same claimant key", async () => {
  const storage = makeStorage();
  const first = await InboxClaimant.bootstrap({
    storageProvider: storage.provider,
    cryptoProvider: CRYPTO,
    delegatedInboxId: BOOTSTRAP_INBOX,
    role: "enrollment",
  });
  assert.equal(first.inboxId, BOOTSTRAP_INBOX);
  assert.equal(await storage.kv.get(PRIMARY_INBOX_KEY), null,
    "the bootstrap inbox is the enrollment route, never any primary");
  assert.equal(await storage.kv.get(PORTABLE_PRIMARY_INBOX_KEY), null);

  const second = await InboxClaimant.bootstrap({
    storageProvider: storage.provider,
    cryptoProvider: CRYPTO,
    delegatedInboxId: BOOTSTRAP_INBOX,
    role: "enrollment",
  });
  assert.equal(second.inboxId, BOOTSTRAP_INBOX);
  assert.equal(second.claimantPublicKeyB64, first.claimantPublicKeyB64,
    "a resumed enrollment boot reattests with the SAME claimant key");
});

test("enrollment role without the bootstrap inboxId fails loud", async () => {
  const storage = makeStorage();
  await assert.rejects(
    () => InboxClaimant.bootstrap({ storageProvider: storage.provider, cryptoProvider: CRYPTO, role: "enrollment" }),
    /requires the delegated envelope's bootstrap inboxId/,
  );
});

test("portable role: the halfway state is a typed ENROLLMENT_INCOMPLETE refusal — the bootstrap inbox is NEVER a fallback", async () => {
  const storage = makeStorage();
  let thrown = null;
  try {
    await InboxClaimant.bootstrap({
      storageProvider: storage.provider,
      cryptoProvider: CRYPTO,
      delegatedInboxId: BOOTSTRAP_INBOX,
      role: "portable",
    });
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown, "the boot must refuse");
  assert.equal(thrown.code, "ENROLLMENT_INCOMPLETE");
  assert.match(thrown.message, /NOT a fallback/);
});

test("portable role resolves the claim-store portable primary; equality with the bootstrap inbox is refused", async () => {
  const storage = makeStorage();
  const provider = makeProviderDouble({ accept: true });
  const establisher = makeEstablisher({ storage, clientFactory: provider.clientFactory });
  const { inboxId } = await establisher.ensureEstablished();

  const claimant = await InboxClaimant.bootstrap({
    storageProvider: storage.provider,
    cryptoProvider: CRYPTO,
    delegatedInboxId: BOOTSTRAP_INBOX,
    role: "portable",
  });
  assert.equal(claimant.inboxId, inboxId, "the steady-state inbox comes from the claim store's portable primary");
  assert.notEqual(claimant.inboxId, BOOTSTRAP_INBOX);

  // Defense in depth: a portable primary that EQUALS the bootstrap inbox is
  // the exact coupling the split removes — refuse it even if storage says so.
  await storage.kv.set(PORTABLE_PRIMARY_INBOX_KEY, BOOTSTRAP_INBOX);
  await assert.rejects(
    () => InboxClaimant.bootstrap({
      storageProvider: storage.provider,
      cryptoProvider: CRYPTO,
      delegatedInboxId: BOOTSTRAP_INBOX,
      role: "portable",
    }),
    /storage inconsistency|split-transport invariant/,
  );
});

test("portable role: a pointer naming a claim the store does not hold is a storage inconsistency, not a mint invitation", async () => {
  const storage = makeStorage();
  await storage.kv.set(PORTABLE_PRIMARY_INBOX_KEY, "inbox:" + "e".repeat(24));
  await assert.rejects(
    () => InboxClaimant.bootstrap({ storageProvider: storage.provider, cryptoProvider: CRYPTO, role: "portable" }),
    /storage inconsistency/,
  );
});

// ---- PortableInboxEstablisher ----

test("establishment mints EXACTLY ONE portable claim (fresh claimant, close key, generation 1) and records the standard lease from the acceptance seam", async () => {
  const storage = makeStorage();
  const provider = makeProviderDouble({ accept: true });
  const establisher = makeEstablisher({ storage, clientFactory: provider.clientFactory });

  const first = await establisher.ensureEstablished();
  assert.match(first.inboxId, /^inbox:[0-9a-f]{24}$/);
  assert.notEqual(first.inboxId, BOOTSTRAP_INBOX);
  assert.equal(first.leased, "accepted");
  assert.equal(await storage.kv.get(PORTABLE_PRIMARY_INBOX_KEY), first.inboxId);

  // The wire claim carried the lease-bearing v2 shape: close key, generation
  // 1, standard retention inside the signed delegation.
  assert.equal(provider.record.claims.length, 1);
  const body = provider.record.claims[0];
  assert.equal(body.inboxId, first.inboxId);
  assert.equal(body.generation, 1);
  assert.ok(body.closePublicKeyB64, "the close key rides in the signed claim");
  assert.equal(body.nodeDelegation.retentionClass, "standard");

  const claim = establisher.claimStore.get(first.inboxId);
  assert.ok(claim.claimantPrivateKeyB64 && claim.closePrivateKeyB64, "claimant + close custody persisted");
  const lease = establisher.claimStore.leaseState(first.inboxId);
  assert.equal(lease.retentionClass, "standard");

  // A second call — same instance — short-circuits on the current lease.
  const again = await establisher.ensureEstablished();
  assert.equal(again.inboxId, first.inboxId);
  assert.equal(again.leased, "current");
  assert.equal(provider.record.factoryCalls, 1, "no second provider round-trip while the lease is current");

  // A crash-restart (fresh instance over the same storage) REUSES the claim —
  // never mints another inbox.
  const provider2 = makeProviderDouble({ accept: true });
  const reborn = makeEstablisher({ storage, clientFactory: provider2.clientFactory });
  const resumed = await reborn.ensureEstablished();
  assert.equal(resumed.inboxId, first.inboxId, "restart reuses the SAME portable inbox");
  assert.equal(provider2.record.factoryCalls, 0, "the recorded lease still stands — no re-claim needed");
  assert.equal(reborn.claimStore.get(first.inboxId).generation, 1);
});

test("a provider failure leaves the claim durably reusable and records NO lease; the retry leases the SAME inbox", async () => {
  const storage = makeStorage();
  const down = makeProviderDouble({ accept: false });
  const establisher = makeEstablisher({ storage, clientFactory: down.clientFactory });

  await assert.rejects(() => establisher.ensureEstablished(), /portable provider refused/);
  const pointer = await storage.kv.get(PORTABLE_PRIMARY_INBOX_KEY);
  assert.ok(pointer, "the minted claim's pointer is durable — restart reuses it");
  assert.equal(establisher.claimStore.leaseState(pointer), null, "no lease was recorded from a failed round-trip");
  assert.equal(down.record.closes, 1, "the establishment client is closed on failure");

  const up = makeProviderDouble({ accept: true });
  const retry = makeEstablisher({ storage, clientFactory: up.clientFactory });
  const result = await retry.ensureEstablished();
  assert.equal(result.inboxId, pointer, "the retry leases the SAME portable inbox — never mints another");
  assert.equal(result.leased, "accepted");
});

test("a portable primary equal to the bootstrap inbox is refused at establishment", async () => {
  const storage = makeStorage();
  const provider = makeProviderDouble({ accept: true });
  // Force the forbidden state: pointer → bootstrap inbox, with a claim for it
  // (the enrollment claim) in the same store.
  const enrollment = await InboxClaimant.bootstrap({
    storageProvider: storage.provider,
    cryptoProvider: CRYPTO,
    delegatedInboxId: BOOTSTRAP_INBOX,
    role: "enrollment",
  });
  assert.equal(enrollment.inboxId, BOOTSTRAP_INBOX);
  await storage.kv.set(PORTABLE_PRIMARY_INBOX_KEY, BOOTSTRAP_INBOX);
  const establisher = makeEstablisher({ storage, clientFactory: provider.clientFactory });
  await assert.rejects(() => establisher.ensureEstablished(), /split-transport invariant/);
  assert.equal(provider.record.factoryCalls, 0, "nothing reached the provider");
});

test("a pointer naming a missing claim refuses to mint a replacement — the published address must never silently change", async () => {
  const storage = makeStorage();
  await storage.kv.set(PORTABLE_PRIMARY_INBOX_KEY, "inbox:" + "f".repeat(24));
  const provider = makeProviderDouble({ accept: true });
  const establisher = makeEstablisher({ storage, clientFactory: provider.clientFactory });
  await assert.rejects(() => establisher.ensureEstablished(), /refusing to mint a replacement/);
});

// ---- The publication seam + the activation commit (no-fallback) ----

function makePublishHarness({ storage, establisher, journalKv }) {
  const calls = { built: [], published: [], requestBaseline: [] };
  const bus = {
    config: { identity: { certChain: [{ certId: "cert-1", granteeDeviceId: "rez:dev:self" }] } },
    runtime: {
      peerLinks: {
        deviceId: "rez:dev:self",
        buildDeviceSetRecordForPeer() { throw new Error("unused in this harness"); },
        async buildAndRetainAccountDeviceBundle(opts) {
          calls.built.push(opts);
          return { inboxId: opts.inboxId };
        },
      },
      sdk: {
        devices: {
          async publishDeviceBundle({ bundle }) {
            calls.published.push(bundle);
            return { published: true };
          },
          async getAccountDeviceSet() {
            return { devices: [{ deviceId: "rez:dev:approver" }] };
          },
        },
      },
    },
    services: {},
    functions: {},
    on() { return () => {}; },
    emit() {},
    registerFunction({ namespace, name, fn }) {
      if (!this.functions[namespace]) this.functions[namespace] = {};
      this.functions[namespace][name] = fn;
    },
    async call(namespace, name, payload) {
      if (namespace === "account-state" && name === "requestActivationBaseline") {
        calls.requestBaseline.push(payload);
        return { sent: true };
      }
      if (namespace === "device-set" && name === "republishToAllPeers") return { published: 0 };
      const fn = this.functions[namespace] && this.functions[namespace][name];
      if (typeof fn === "function") return fn(payload);
      throw new Error("missing " + namespace + "." + name);
    },
  };
  const deviceSet = new ServerDeviceSetService({
    bus,
    ownerAccountId: "rez:acct:alice",
    portableInboxEstablisher: establisher,
    logger: silentLogger,
  });
  const activation = new ServerDeviceActivationService({
    bus,
    ownerAccountId: "rez:acct:alice",
    storageProvider: { getKeyValueStore: () => journalKv },
    logger: silentLogger,
  });
  return { bus, calls, deviceSet, activation };
}

test("the published bundle carries the PORTABLE inbox — never the session's claimed inbox", async () => {
  const storage = makeStorage();
  const provider = makeProviderDouble({ accept: true });
  const establisher = makeEstablisher({ storage, clientFactory: provider.clientFactory });
  const { calls, deviceSet } = makePublishHarness({ storage, establisher, journalKv: makeKv() });

  const result = await deviceSet.publishOwnDeviceBundle({ nowMs: 5_000 });
  assert.ok(result && result.published);
  const portable = await storage.kv.get(PORTABLE_PRIMARY_INBOX_KEY);
  assert.equal(calls.built.length, 1);
  assert.equal(calls.built[0].inboxId, portable, "the bundle build was handed the portable inbox explicitly");
  assert.equal(calls.published[0].inboxId, portable);
  assert.notEqual(portable, BOOTSTRAP_INBOX);
});

test("NO-FALLBACK: a failed portable establishment makes publication impossible, the READY commit stays READY, and the retry commits once the provider heals", async () => {
  const storage = makeStorage();
  const journalKv = makeKv();

  // Seed a READY journal — the crash boundary under attack: baseline done,
  // portable not yet established, publication owed.
  const journal = new DeviceActivationJournal({ storageProvider: { getKeyValueStore: () => journalKv } });
  await journal.hydrate();
  await journal.ensureBootstrapping({ activationId: "cert-1", nowMs: 1 });
  await journal.markReady({ baselineOrigin: "rez:dev:approver", horizonLamport: 3 });

  const down = makeProviderDouble({ accept: false });
  const establisher = makeEstablisher({ storage, clientFactory: down.clientFactory });
  const harness = makePublishHarness({ storage, establisher, journalKv });

  // The sync's READY branch performs the commit; the commit publishes through
  // the establisher; the establisher cannot lease → the whole commit fails …
  await assert.rejects(() => harness.activation.syncWithNetwork(), /portable provider refused/);
  // … and NOTHING left the device: no bundle bytes, journal still READY —
  // unpublished and recoverable, exactly the ruled behavior. No path
  // published the bootstrap inbox "to get the device active for now".
  assert.equal(harness.calls.published.length, 0, "no wire op — publication is impossible without the portable inbox");
  assert.equal(harness.calls.built.length, 0);
  const freshJournal = new DeviceActivationJournal({ storageProvider: { getKeyValueStore: () => journalKv } });
  await freshJournal.hydrate();
  assert.equal(freshJournal.get().state, ACTIVATION_STATES.READY, "the commit did not half-happen");

  // The provider heals: the SAME storage retries — reuses the SAME portable
  // claim (minted durably during the failed attempt) and commits exactly once.
  const up = makeProviderDouble({ accept: true });
  const healed = makeEstablisher({ storage, clientFactory: up.clientFactory });
  const harness2 = makePublishHarness({ storage, establisher: healed, journalKv });
  const outcome = await harness2.activation.syncWithNetwork();
  assert.equal(outcome.state, ACTIVATION_STATES.ACTIVE);
  const portable = await storage.kv.get(PORTABLE_PRIMARY_INBOX_KEY);
  assert.equal(harness2.calls.published.length, 1);
  assert.equal(harness2.calls.published[0].inboxId, portable, "the commit published the portable address");
  const doneJournal = new DeviceActivationJournal({ storageProvider: { getKeyValueStore: () => journalKv } });
  await doneJournal.hydrate();
  assert.equal(doneJournal.get().state, ACTIVATION_STATES.ACTIVE);
});

test("ONE claim store per storage domain: establishment through the SHARED store never clobbers the bootstrap claim's recorded lease", async () => {
  const storage = makeStorage();
  const provider = makeProviderDouble({ accept: true });
  const establisher = makeEstablisher({ storage, clientFactory: provider.clientFactory });

  // The enrollment runtime's claimant shares the establisher's store (the
  // bootstrapChatRuntime wiring). Simulate its work: claim the bootstrap
  // inbox and record the lease the pg home granted.
  const claimant = await InboxClaimant.bootstrap({
    storageProvider: storage.provider,
    cryptoProvider: CRYPTO,
    delegatedInboxId: BOOTSTRAP_INBOX,
    role: "enrollment",
    claimStore: establisher.claimStore,
  });
  assert.equal(claimant.claimStore, establisher.claimStore, "the wiring shares ONE store instance");
  await establisher.claimStore.recordAcceptedLease({
    inboxId: BOOTSTRAP_INBOX,
    issuedAtMs: 100,
    expiresAtMs: 100 + 7 * 24 * 60 * 60 * 1000,
    retentionClass: "transient",
  });

  // The portable establishment persists through the SAME store — the
  // bootstrap claim and its lease must survive (the two-instance wiring
  // silently dropped them: whole-array persistAll is last-writer-wins).
  const { inboxId } = await establisher.ensureEstablished();
  assert.notEqual(inboxId, BOOTSTRAP_INBOX);
  const bootstrapLease = establisher.claimStore.leaseState(BOOTSTRAP_INBOX);
  assert.ok(bootstrapLease, "the bootstrap lease survived the portable persist");
  assert.equal(bootstrapLease.issuedAtMs, 100);
  assert.ok(establisher.claimStore.get(BOOTSTRAP_INBOX), "the bootstrap claim record survived");
  assert.ok(establisher.claimStore.leaseState(inboxId), "and the portable lease is recorded alongside it");
});
