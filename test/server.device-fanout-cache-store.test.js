import test from "node:test";
import assert from "node:assert/strict";
import { DeviceFanoutCacheStore, DEVICE_FANOUT_PREFIX } from "../src/server/storage/DeviceFanoutCacheStore.js";

// Audit R3 #4 / R4 #7 — the durable per-(owner, peer, messageId, peerDeviceId)
// sealed-ciphertext cache. Proves round-trip fidelity, the deliveredOk mark,
// TTL-at-lookup eviction (not only at capacity), prune(), the full-tuple key
// (no owner/peer collision), and that the persisted value is an RRecord.

function makeStorageProvider() {
  const m = new Map();
  const kv = {
    async get(k) { return m.has(k) ? JSON.parse(m.get(k)) : undefined; },
    async set(k, v) { m.set(k, JSON.stringify(v)); },
    async delete(k) { return m.delete(k); },
    async keys(prefix) { const o = []; for (const k of m.keys()) if (!prefix || k.startsWith(prefix)) o.push(k); return o; },
  };
  return { getKeyValueStore() { return kv; }, _map: m };
}

function coords({ owner = "rez:acct:me", peer = "rez:acct:peer", messageId = "msg1", deviceId = "dev1" } = {}) {
  return { ownerAccountId: owner, peerAccountId: peer, messageId, peerDeviceId: deviceId };
}

function sealed(deviceId) {
  return {
    object: { payloadBytes: new TextEncoder().encode("ct-" + deviceId), metadata: { peerDeviceId: deviceId }, capChain: null },
    address: { kind: "inbox", inboxId: "inbox:" + deviceId },
  };
}

test("put/get round-trips the sealed ciphertext (payloadBytes survive base64) and persists an RRecord", async () => {
  const sp = makeStorageProvider();
  const store = new DeviceFanoutCacheStore({ storageProvider: sp, clock: () => 1000 });
  const c = coords();
  await store.put(c, sealed("dev1"));
  const got = await store.get(c);
  assert.ok(got, "entry present");
  assert.equal(got.deliveredOk, false);
  assert.deepEqual([...got.sealed.object.payloadBytes], [...new TextEncoder().encode("ct-dev1")]);
  assert.deepEqual(got.sealed.address, { kind: "inbox", inboxId: "inbox:dev1" });
  assert.deepEqual(got.sealed.object.metadata, { peerDeviceId: "dev1" });
  // The persisted value is the DeviceFanoutCacheEntryV1 record shape (built +
  // validated on every put), carrying owner + peer identity — not the old
  // ad-hoc {payloadB64,...} object keyed on messageId::deviceId alone.
  const stored = [...sp._map.values()].map((v) => JSON.parse(v))[0];
  assert.equal(stored.ownerAccountId, "rez:acct:me");
  assert.equal(stored.peerAccountId, "rez:acct:peer");
  assert.equal(stored.peerDeviceId, "dev1");
  assert.equal(stored.messageId, "msg1");
  assert.equal(typeof stored.payloadB64, "string");
});

test("the full tuple keys the slot: same messageId+device but different peer do not collide", async () => {
  const store = new DeviceFanoutCacheStore({ storageProvider: makeStorageProvider(), clock: () => 1000 });
  const a = coords({ peer: "rez:acct:alice" });
  const b = coords({ peer: "rez:acct:bob" });
  await store.put(a, sealed("devA"));
  await store.put(b, sealed("devB"));
  assert.deepEqual([...(await store.get(a)).sealed.object.payloadBytes], [...new TextEncoder().encode("ct-devA")]);
  assert.deepEqual([...(await store.get(b)).sealed.object.payloadBytes], [...new TextEncoder().encode("ct-devB")]);
});

test("markDelivered flips deliveredOk; get reflects it", async () => {
  const store = new DeviceFanoutCacheStore({ storageProvider: makeStorageProvider(), clock: () => 1000 });
  const c = coords();
  await store.put(c, sealed("dev1"));
  await store.markDelivered(c);
  const got = await store.get(c);
  assert.equal(got.deliveredOk, true);
});

test("markDelivered is a no-op when the entry is gone (already pruned/expired)", async () => {
  const store = new DeviceFanoutCacheStore({ storageProvider: makeStorageProvider(), clock: () => 1000 });
  await store.markDelivered(coords({ messageId: "absent" })); // must not throw
  assert.equal(await store.get(coords({ messageId: "absent" })), null);
});

test("TTL is enforced AT LOOKUP: an aged entry reads as a miss and is evicted", async () => {
  let now = 1000;
  const sp = makeStorageProvider();
  const store = new DeviceFanoutCacheStore({ storageProvider: sp, clock: () => now, ttlMs: 10_000 });
  const c = coords();
  await store.put(c, sealed("dev1"));
  now = 1000 + 10_001; // past TTL
  assert.equal(await store.get(c), null, "expired entry reads as a miss");
  const keys = await sp.getKeyValueStore().keys(DEVICE_FANOUT_PREFIX);
  assert.equal(keys.length, 0, "the expired entry was evicted in place at lookup");
});

test("prune() sweeps expired entries that are never read again", async () => {
  let now = 1000;
  const sp = makeStorageProvider();
  const store = new DeviceFanoutCacheStore({ storageProvider: sp, clock: () => now, ttlMs: 10_000 });
  await store.put(coords({ messageId: "m1" }), sealed("dev1"));
  await store.put(coords({ messageId: "m2" }), sealed("dev2"));
  now = 1000 + 10_001;
  await store.put(coords({ messageId: "m3" }), sealed("dev3")); // fresh at the new now
  const evicted = await store.prune();
  assert.equal(evicted, 2, "the two aged entries were pruned");
  assert.ok(await store.get(coords({ messageId: "m3" })), "the fresh entry survived");
});

test("incomplete coords are a no-op (messageId-less / identity-less sends are never cached)", async () => {
  const store = new DeviceFanoutCacheStore({ storageProvider: makeStorageProvider(), clock: () => 1000 });
  await store.put(coords({ messageId: "" }), sealed("dev1"));
  assert.equal(await store.get(coords({ messageId: "" })), null);
  await store.put({ peerAccountId: "p", messageId: "m", peerDeviceId: "d" }, sealed("dev1")); // no owner
  assert.equal(await store.get({ peerAccountId: "p", messageId: "m", peerDeviceId: "d" }), null);
});
