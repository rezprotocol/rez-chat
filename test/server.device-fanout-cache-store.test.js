import test from "node:test";
import assert from "node:assert/strict";
import { DeviceFanoutCacheStore, DEVICE_FANOUT_PREFIX } from "../src/server/storage/DeviceFanoutCacheStore.js";

// Audit R3 #4 — the durable per-(messageId, peerDeviceId) sealed-ciphertext
// cache. Proves round-trip fidelity, the deliveredOk mark, TTL-at-lookup
// eviction (not only at capacity), and prune().

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

function sealed(deviceId) {
  return {
    object: { payloadBytes: new TextEncoder().encode("ct-" + deviceId), metadata: { peerDeviceId: deviceId }, capChain: null },
    address: { kind: "inbox", inboxId: "inbox:" + deviceId },
  };
}

test("put/get round-trips the sealed ciphertext (payloadBytes survive base64)", async () => {
  const store = new DeviceFanoutCacheStore({ storageProvider: makeStorageProvider(), clock: () => 1000 });
  await store.put("msg::dev1", sealed("dev1"));
  const got = await store.get("msg::dev1");
  assert.ok(got, "entry present");
  assert.equal(got.deliveredOk, false);
  assert.deepEqual([...got.sealed.object.payloadBytes], [...new TextEncoder().encode("ct-dev1")]);
  assert.deepEqual(got.sealed.address, { kind: "inbox", inboxId: "inbox:dev1" });
  assert.deepEqual(got.sealed.object.metadata, { peerDeviceId: "dev1" });
});

test("markDelivered flips deliveredOk; get reflects it", async () => {
  const store = new DeviceFanoutCacheStore({ storageProvider: makeStorageProvider(), clock: () => 1000 });
  await store.put("msg::dev1", sealed("dev1"));
  await store.markDelivered("msg::dev1");
  const got = await store.get("msg::dev1");
  assert.equal(got.deliveredOk, true);
});

test("markDelivered is a no-op when the entry is gone (already pruned/expired)", async () => {
  const store = new DeviceFanoutCacheStore({ storageProvider: makeStorageProvider(), clock: () => 1000 });
  await store.markDelivered("msg::absent"); // must not throw
  assert.equal(await store.get("msg::absent"), null);
});

test("TTL is enforced AT LOOKUP: an aged entry reads as a miss and is evicted", async () => {
  let now = 1000;
  const sp = makeStorageProvider();
  const store = new DeviceFanoutCacheStore({ storageProvider: sp, clock: () => now, ttlMs: 10_000 });
  await store.put("msg::dev1", sealed("dev1"));
  now = 1000 + 10_001; // past TTL
  assert.equal(await store.get("msg::dev1"), null, "expired entry reads as a miss");
  const keys = await sp.getKeyValueStore().keys(DEVICE_FANOUT_PREFIX);
  assert.equal(keys.length, 0, "the expired entry was evicted in place at lookup");
});

test("prune() sweeps expired entries that are never read again", async () => {
  let now = 1000;
  const sp = makeStorageProvider();
  const store = new DeviceFanoutCacheStore({ storageProvider: sp, clock: () => now, ttlMs: 10_000 });
  await store.put("msg::dev1", sealed("dev1"));
  await store.put("msg::dev2", sealed("dev2"));
  now = 1000 + 10_001;
  await store.put("msg::dev3", sealed("dev3")); // fresh at the new now
  const evicted = await store.prune();
  assert.equal(evicted, 2, "the two aged entries were pruned");
  assert.ok(await store.get("msg::dev3"), "the fresh entry survived");
});

test("empty cacheKey is a no-op (messageId-less sends are never cached)", async () => {
  const store = new DeviceFanoutCacheStore({ storageProvider: makeStorageProvider(), clock: () => 1000 });
  await store.put("", sealed("dev1"));
  assert.equal(await store.get(""), null);
});
