// M4 (plans/MOBILE_LIFECYCLE_ADAPTER_PLAN.md §7/§7b) — accountMultiDevice
// decoupled from the multiDeviceFanout home capability, with the frozen
// security rule under test:
//
//   For sibling account-state transmission, stale knowledge may omit an
//   active device, but it may never knowingly retain a revoked device. If
//   current revocation state cannot be established, outbound sibling
//   synchronization defers rather than failing open.
//
// Composition: effective ACTIVE devices = durable last-known roster GATED by
// the current VERIFIED authority epoch (roster.epoch >= verified epoch ⇒ the
// registry-JOINed snapshot already excludes everything revoked; a higher
// verified epoch ⇒ membership changed in an unknown way ⇒ DEFER). Revocation
// awareness reaches the data plane with ZERO account sessions — proven
// mechanically via AccountControlChannel.executeCount.

import test from "node:test";
import assert from "node:assert/strict";

import { ChatServerBus } from "../src/server/app/ChatServerBus.js";
import { AccountDeviceRosterStore } from "../src/server/storage/AccountDeviceRosterStore.js";
import { ServerAccountStateSyncService } from "../src/server/services/ServerAccountStateSyncService.js";
import { ServerAccountMutationService } from "../src/server/services/ServerAccountMutationService.js";
import { AccountControlChannel } from "../src/server/runtime/AccountControlChannel.js";

const QUIET = { log() {}, warn() {}, info() {}, error() {} };
const OWNER = "rez:acct:m4";
const SELF_DEVICE = "rez:dev:self";
const SIBLING_DEVICE = "rez:dev:sibling";
const SIBLING_INBOX = "inbox:aaaaaaaaaaaaaaaaaaaaaaab";

class TestKVStore {
  constructor() { this._data = new Map(); }
  async get(key) { return this._data.has(key) ? this._data.get(key) : null; }
  async getStrict(key) { return this._data.has(key) ? this._data.get(key) : undefined; }
  async set(key, value) { this._data.set(key, JSON.parse(JSON.stringify(value))); }
  async delete(key) { this._data.delete(key); }
  async keys(prefix) {
    const out = [];
    for (const k of this._data.keys()) if (k.startsWith(prefix)) out.push(k);
    return out;
  }
}
class TestStorageProvider {
  constructor() { this._stores = new Map(); }
  getKeyValueStore(name) {
    if (!this._stores.has(name)) this._stores.set(name, new TestKVStore());
    return this._stores.get(name);
  }
}

// A CLAIMANT-shaped sdk: data-plane surfaces work; every account-mode surface
// throws exactly like RezClient's #requireAccountMode — so any code path that
// reaches for account authority fails the test loudly instead of silently
// passing against a permissive mock.
function makeClaimantSdk({ authorityRecordRef, dispatched }) {
  const claimantThrow = (name) => {
    throw new Error("RezClient." + name + " requires an account-mode client — this client authenticates as a CLAIMANT");
  };
  return {
    get devices() { return claimantThrow("devices"); },
    get identity() { return claimantThrow("identity"); },
    async listSiblingDeviceInboxes() { return claimantThrow("listSiblingDeviceInboxes"); },
    durableRecords: {
      async get(coords) {
        if (authorityRecordRef.fetchError) throw new Error(authorityRecordRef.fetchError);
        return authorityRecordRef.record;
      },
    },
    async buildAccountStateDeposit({ deliverInboxId, plaintextBodyBytes }) {
      return { object: { payloadBytes: plaintextBodyBytes, metadata: {}, capChain: null }, address: { inboxId: deliverInboxId } };
    },
    mesh: {
      async dispatch(object, address) { dispatched.push({ inboxId: address.inboxId }); },
    },
  };
}

// peerLinks double: device identity + the own-authority open surface. The
// "verification" here trusts authorityRecordRef the way the real (sdk-tested,
// un-mocked) openOwnAuthorityStateRecord verifies crypto — the chat layer under
// test is the COMPOSITION, and the crypto seam is proven in
// rez-sdk/test/peer-link.device-set.delegated.test.js.
function makePeerLinks({ authorityRecordRef }) {
  return {
    deviceId: SELF_DEVICE,
    devicePublicKeyB64: "self-device-pub",
    buildDeviceSetRecordForPeer() { return {}; },
    async signAccountStateEvent() { return { sigB64: "sig" }; },
    async ownAuthorityStateCoordinates() {
      return { recordKind: "account-authority-state", recordId: "v1", publisherPublicKeyB64: "acct-pub" };
    },
    async openOwnAuthorityStateRecord({ record }) {
      if (record.verifyError) throw new Error(record.verifyError);
      return {
        authorityState: record,
        revocationState: { revokedCertIds: record.revokedCertIds || [], minValidIssuedAtMs: 0 },
        epoch: record.epoch,
      };
    },
  };
}

function makeHarness({ rosterDevices = null, rosterEpoch = 0 } = {}) {
  const bus = new ChatServerBus({ config: {}, logger: QUIET });
  const storage = new TestStorageProvider();
  const dispatched = [];
  const authorityRecordRef = { record: null, fetchError: null };
  const sdk = makeClaimantSdk({ authorityRecordRef, dispatched });
  const peerLinks = makePeerLinks({ authorityRecordRef });
  bus.runtime.sdk = sdk;
  bus.runtime.peerLinks = peerLinks;
  bus.runtime.sessionMode = "claimant";
  bus.runtime.multiDeviceFanout = false; // the claimant per-session home capability, unchanged

  const rosterStore = new AccountDeviceRosterStore({ storageProvider: storage, ownerAccountId: OWNER });
  bus.stores.deviceRosterStore = rosterStore;

  const mutation = new ServerAccountMutationService({ bus, ownerAccountId: OWNER, logger: QUIET });
  const sync = new ServerAccountStateSyncService({ bus, storageProvider: storage, ownerAccountId: OWNER, logger: QUIET });
  bus.services.accountStateSync = sync;
  bus.services.accountMutation = mutation;

  // Real AccountControlChannel with a never-connecting client factory: the
  // proof is that execute() is NEVER CALLED, so the factory must never run.
  const control = new AccountControlChannel({
    identity: { publicKeyB64: "acct-pub", privateKeyB64: "acct-priv" },
    uplinks: ["ws://node"],
    clientFactory: () => { throw new Error("account session opened — the M4 rule is violated"); },
    logger: QUIET,
  });
  bus.runtime.accountControl = control;

  const seed = async () => {
    if (rosterDevices) {
      await rosterStore.replaceSnapshot({ devices: rosterDevices, epoch: rosterEpoch, snapshotAtMs: 1000 });
    }
  };
  return { bus, sync, mutation, rosterStore, control, dispatched, authorityRecordRef, seed };
}

const TWO_DEVICE_ROSTER = [
  { deviceId: SELF_DEVICE, inboxId: "inbox:aaaaaaaaaaaaaaaaaaaaaaaa" },
  { deviceId: SIBLING_DEVICE, inboxId: SIBLING_INBOX },
];

test("M4 kill shot (the strong true→false): a revocation published at epoch N+1 flips accountMultiDevice and removes the sibling from targets — with ZERO account sessions", async () => {
  const h = makeHarness({ rosterDevices: TWO_DEVICE_ROSTER, rosterEpoch: 5 });
  await h.seed();

  // Verified authority at epoch N (=5): roster is current.
  h.authorityRecordRef.record = { epoch: 5, revokedCertIds: [] };
  let refreshed = await h.bus.call("account-state", "refreshAccountMultiDevice", {});
  assert.equal(refreshed.accountMultiDevice, true);
  assert.equal(h.bus.runtime.accountMultiDevice, true);
  assert.equal(h.sync.isEnabled(), true, "claimant session participates in sibling convergence");

  let targets = await h.sync.siblingTargets();
  assert.equal(targets.deferred, false);
  assert.deepEqual(targets.targets, [{ deviceId: SIBLING_DEVICE, inboxId: SIBLING_INBOX }]);

  const round1 = await h.sync.replicate({ op: "contact.upsert", payload: { accountId: "rez:acct:peer", relationshipState: "active" } });
  assert.equal(round1.fannedOut, 1, "epoch-current roster fans out to the sibling");
  assert.equal(h.dispatched.length, 1);

  // WITHOUT any account session: the account publishes authority epoch N+1
  // (B revoked elsewhere). The data plane sees only the public record.
  h.authorityRecordRef.record = { epoch: 6, revokedCertIds: ["rez:cap:" + "ab".repeat(32)] };
  h.mutation.invalidateOwnAuthorityState(); // the 5-min TTL elapses; tests skip the wait

  refreshed = await h.bus.call("account-state", "refreshAccountMultiDevice", {});
  assert.equal(refreshed.accountMultiDevice, false, "epoch advanced past the roster → membership unknown → OFF");
  assert.equal(h.bus.runtime.accountMultiDevice, false);

  targets = await h.sync.siblingTargets();
  assert.equal(targets.deferred, true, "sends DEFER — never fan to yesterday's roster");
  assert.match(targets.reason, /authority-epoch-advanced/);

  // The disabled gate (accountMultiDevice=false) short-circuits before
  // resolution, so `deferred` may be absent — the property is fannedOut 0.
  const round2 = await h.sync.replicate({ op: "contact.upsert", payload: { accountId: "rez:acct:peer", relationshipState: "active" } });
  assert.equal(round2.fannedOut, 0);
  assert.equal(h.dispatched.length, 1, "no post-revocation deposit ever left this device");

  // The invariant, mechanically: revocation awareness reached the data plane
  // without account authority appearing anywhere.
  assert.equal(h.control.executeCount, 0, "AccountControlChannel.executeCount === 0 through the entire transition");
  assert.equal(h.control.active, false);
});

test("M4: authority state UNESTABLISHABLE (fetch fails) → outbound sibling sync defers; recovery re-enables without restart", async () => {
  const h = makeHarness({ rosterDevices: TWO_DEVICE_ROSTER, rosterEpoch: 5 });
  await h.seed();

  h.authorityRecordRef.fetchError = "network unreachable";
  const refreshed = await h.bus.call("account-state", "refreshAccountMultiDevice", {});
  assert.equal(refreshed.accountMultiDevice, false);
  const targets = await h.sync.siblingTargets();
  assert.equal(targets.deferred, true, "cannot establish → defer, never fail open");

  // The failure is NOT cached: the next round recovers immediately.
  h.authorityRecordRef.fetchError = null;
  h.authorityRecordRef.record = { epoch: 5, revokedCertIds: [] };
  const recovered = await h.sync.siblingTargets();
  assert.equal(recovered.deferred, false);
  assert.equal(recovered.targets.length, 1);
  assert.equal(h.control.executeCount, 0);
});

test("M4: NO published authority state (pre-S11 account, never any revocations) is ESTABLISHED — the roster stands", async () => {
  const h = makeHarness({ rosterDevices: TWO_DEVICE_ROSTER, rosterEpoch: 0 });
  await h.seed();
  h.authorityRecordRef.record = null; // durableRecords.get → null
  const refreshed = await h.bus.call("account-state", "refreshAccountMultiDevice", {});
  assert.equal(refreshed.accountMultiDevice, true, "no record is a real answer (nothing ever revoked), not an outage");
  const targets = await h.sync.siblingTargets();
  assert.equal(targets.deferred, false);
  assert.equal(h.control.executeCount, 0);
});

test("M4: no roster (single-device or never-snapshotted) → accountMultiDevice false, zero targets, nothing sent", async () => {
  const h = makeHarness();
  await h.seed();
  h.authorityRecordRef.record = { epoch: 3, revokedCertIds: [] };
  const refreshed = await h.bus.call("account-state", "refreshAccountMultiDevice", {});
  assert.equal(refreshed.accountMultiDevice, false);
  assert.equal(h.sync.isEnabled(), false, "no sibling machinery without multiplicity");
  const round = await h.sync.replicate({ op: "contact.upsert", payload: { accountId: "rez:acct:peer", relationshipState: "active" } });
  assert.equal(round.fannedOut, 0);
  assert.equal(h.dispatched.length, 0);
  assert.equal(h.control.executeCount, 0);
});

test("M4: flushPending re-verifies membership — deferred resolution keeps entries; an inbox no longer ACTIVE is dropped loudly, never sent", async () => {
  const h = makeHarness({ rosterDevices: TWO_DEVICE_ROSTER, rosterEpoch: 5 });
  await h.seed();
  h.authorityRecordRef.record = { epoch: 5, revokedCertIds: [] };
  await h.bus.call("account-state", "refreshAccountMultiDevice", {});

  // Queue a pending send through the REAL path: dispatch fails once, so
  // replicate stashes the signed event for retry.
  const realDispatch = h.bus.runtime.sdk.mesh.dispatch;
  h.bus.runtime.sdk.mesh.dispatch = async () => { throw new Error("offline"); };
  await h.sync.replicate({ op: "contact.upsert", payload: { accountId: "rez:acct:peer", relationshipState: "active" } });
  h.bus.runtime.sdk.mesh.dispatch = realDispatch;

  // 1) Membership unestablishable → flush defers, entry KEPT.
  h.mutation.invalidateOwnAuthorityState();
  h.authorityRecordRef.fetchError = "still offline";
  let flush = await h.sync.flushPending();
  assert.equal(flush.deferred, true);
  assert.equal(flush.flushed, 0);

  // 2) Roster refreshed WITHOUT the sibling (revoked; epoch matched by a new
  //    snapshot) → the queued entry to its inbox is DROPPED, not delivered.
  h.authorityRecordRef.fetchError = null;
  h.authorityRecordRef.record = { epoch: 6, revokedCertIds: ["rez:cap:" + "cd".repeat(32)] };
  h.mutation.invalidateOwnAuthorityState();
  await h.rosterStore.replaceSnapshot({ devices: [TWO_DEVICE_ROSTER[0]], epoch: 6, snapshotAtMs: 2000 });
  flush = await h.sync.flushPending();
  assert.equal(flush.dropped, 1, "the queued send to the removed device is dropped");
  assert.equal(flush.flushed, 0);
  assert.equal(h.dispatched.length, 0, "nothing was ever delivered to the revoked device");
  assert.equal(h.control.executeCount, 0);
});

test("M4: the legacy home-fanout path is byte-identical — multiDeviceFanout=true uses listSiblingDeviceInboxes, no roster consulted", async () => {
  const bus = new ChatServerBus({ config: {}, logger: QUIET });
  const storage = new TestStorageProvider();
  const dispatched = [];
  const siblings = [{ deviceId: SIBLING_DEVICE, inboxId: SIBLING_INBOX }];
  bus.runtime.sdk = {
    async listSiblingDeviceInboxes() { return siblings; },
    async buildAccountStateDeposit({ deliverInboxId, plaintextBodyBytes }) {
      return { object: { payloadBytes: plaintextBodyBytes, metadata: {}, capChain: null }, address: { inboxId: deliverInboxId } };
    },
    mesh: { async dispatch(o, a) { dispatched.push(a.inboxId); } },
  };
  bus.runtime.peerLinks = {
    deviceId: SELF_DEVICE,
    devicePublicKeyB64: "self-device-pub",
    async signAccountStateEvent() { return { sigB64: "sig" }; },
  };
  bus.runtime.multiDeviceFanout = true;
  // NO roster store, NO accountMultiDevice, NO account-mutation service:
  // the shipped path must neither need nor touch any of them.
  const sync = new ServerAccountStateSyncService({ bus, storageProvider: storage, ownerAccountId: OWNER, logger: QUIET });
  bus.services.accountStateSync = sync;

  assert.equal(sync.isEnabled(), true);
  const round = await sync.replicate({ op: "contact.upsert", payload: { accountId: "rez:acct:peer", relationshipState: "active" } });
  assert.equal(round.fannedOut, 1);
  assert.deepEqual(dispatched, [SIBLING_INBOX]);
});

// ---- AccountDeviceRosterStore unit coverage ----

test("M4 roster store: full-snapshot replace, durability across rehydration, and rollback on persist failure", async () => {
  const storage = new TestStorageProvider();
  const store = new AccountDeviceRosterStore({ storageProvider: storage, ownerAccountId: OWNER });
  assert.equal(await store.snapshot(), null);

  await store.replaceSnapshot({ devices: TWO_DEVICE_ROSTER, epoch: 3, snapshotAtMs: 500 });
  const rehydrated = new AccountDeviceRosterStore({ storageProvider: storage, ownerAccountId: OWNER });
  const snap = await rehydrated.snapshot();
  assert.equal(snap.epoch, 3);
  assert.equal(snap.devices.length, 2);

  // A device absent from the new snapshot is GONE (the account-plane half of
  // the true→false transition).
  await store.replaceSnapshot({ devices: [TWO_DEVICE_ROSTER[0]], epoch: 4, snapshotAtMs: 600 });
  assert.equal((await store.snapshot()).devices.length, 1);

  // Persist failure rolls back: the view never outruns disk.
  const kv = storage.getKeyValueStore(null);
  const realSet = kv.set.bind(kv);
  kv.set = async () => { throw new Error("disk full"); };
  await assert.rejects(store.replaceSnapshot({ devices: TWO_DEVICE_ROSTER, epoch: 5 }), /disk full/);
  kv.set = realSet;
  const after = await store.snapshot();
  assert.equal(after.epoch, 4, "previous snapshot intact after a failed replace");
  assert.equal(after.devices.length, 1);
});

test("M4 roster store: replaceFromAggregate maps wire rows (inboxId from the signed bundle) and refuses rows without routing", async () => {
  const storage = new TestStorageProvider();
  const store = new AccountDeviceRosterStore({ storageProvider: storage, ownerAccountId: OWNER });
  await store.replaceFromAggregate({
    devices: [
      { deviceId: SELF_DEVICE, prekeyVersion: 2, bundle: { inboxId: "inbox:aaaaaaaaaaaaaaaaaaaaaaaa" } },
      { deviceId: SIBLING_DEVICE, prekeyVersion: 1, bundle: { inboxId: SIBLING_INBOX } },
    ],
    epoch: 2,
  });
  const snap = await store.snapshot();
  assert.deepEqual(snap.devices.map((d) => d.deviceId), [SELF_DEVICE, SIBLING_DEVICE]);

  await assert.rejects(
    store.replaceFromAggregate({ devices: [{ deviceId: "rez:dev:x", prekeyVersion: 1, bundle: {} }], epoch: 3 }),
    /deviceId \+ inboxId/,
  );
});
