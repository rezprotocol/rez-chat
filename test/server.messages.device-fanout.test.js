import test from "node:test";
import assert from "node:assert/strict";
import { ServerMessagesService } from "../src/server/services/ServerMessagesService.js";
import { DeviceFanoutCacheStore } from "../src/server/storage/DeviceFanoutCacheStore.js";

// An in-memory KV that clones on write (mimics the real FS/pg KV's JSON
// round-trip), so the durable device-fanout cache is exercised faithfully and a
// non-JSON-safe regression would surface.
function makeStorageProvider() {
  const m = new Map();
  const kv = {
    async get(k) { return m.has(k) ? JSON.parse(m.get(k)) : undefined; },
    async set(k, v) { m.set(k, JSON.stringify(v)); },
    async delete(k) { return m.delete(k); },
    async keys(prefix) { const o = []; for (const k of m.keys()) if (!prefix || k.startsWith(prefix)) o.push(k); return o; },
  };
  return { getKeyValueStore() { return kv; } };
}

// S2.5 Slice 5 leaf 2 — the GATED per-device sender fan-out DECISION. Drives the
// public sendMessage for a DM thread and asserts:
//  - gate CLOSED (default): the legacy single-device sealForPeer path runs
//    (sealForPeerDevice never called) — the shipped behaviour, unchanged.
//  - gate OPEN + a resolvable device set: one sealForPeerDevice per device,
//    delivered to each device's own inbox; sealForPeer never called.
// The crypto + envelope are proven un-mocked elsewhere (device-set service e2e;
// SDK sealForPeerDevice). This pins the routing decision on the hot path.

const OWNER = "rez:acct:owner";
const PEER = "rez:acct:peer";
const THREAD_ID = "th_owner_peer_direct";

function makeHarness({ multiDeviceFanout = false, deviceSet = null, storageProvider = makeStorageProvider() } = {}) {
  const calls = { sealForPeer: [], sealForPeerDevice: [], dispatch: [] };
  const sdk = {
    getIdentity: () => ({ localInboxId: "inbox:owner" }),
    sealForPeer: async (a) => { calls.sealForPeer.push(a); return { object: { sf: true }, address: { inboxId: a.deliverInboxId } }; },
    // Mirror the real sealForPeerDevice shape so the durable cache round-trips
    // faithfully: object carries Uint8Array payloadBytes + plain metadata.
    sealForPeerDevice: async (a) => {
      calls.sealForPeerDevice.push(a);
      return {
        object: { payloadBytes: new TextEncoder().encode("ct-" + a.peerDeviceId), metadata: { peerDeviceId: a.peerDeviceId }, capChain: null },
        address: { inboxId: a.deliverInboxId },
      };
    },
    mesh: { dispatch: async (object, address) => { calls.dispatch.push({ object, address }); return { queued: false }; } },
  };
  const threadStore = {
    async recordOutboundDeposit() {},
    async setMessageStatus() {},
    async getThread() { return { threadType: "direct", peerAccountId: PEER, peerInboxId: "inbox:peer" }; },
  };
  const threadIndex = { async upsertFromMessage() { return null; } };
  const groupStore = {};
  const bus = {
    runtime: { sdk, multiDeviceFanout },
    services: { threads: { extractPreviewText: () => "preview", emitThreadIndexUpdated() {} } },
    on() { return () => {}; },
    emit() {},
    registerFunction() {},
    call(ns, name) {
      if (ns === "device-set" && name === "resolveForPeer") return Promise.resolve(deviceSet);
      return Promise.resolve(null);
    },
  };
  const deviceFanoutStore = new DeviceFanoutCacheStore({ storageProvider, clock: () => 1000 });
  const svc = new ServerMessagesService({ bus, threadStore, threadIndex, groupStore, deviceFanoutStore, ownerAccountId: OWNER, clock: () => 1000 });
  return { svc, calls, sdk, storageProvider };
}

test("gate CLOSED: a DM send uses the legacy single-device sealForPeer (no per-device fan-out)", async () => {
  const { svc, calls } = makeHarness({ multiDeviceFanout: false });
  await svc.sendMessage({ threadId: THREAD_ID, payload: { text: "hello" } });
  assert.equal(calls.sealForPeer.length, 1, "legacy path sealed once for the peer");
  assert.equal(calls.sealForPeerDevice.length, 0, "no per-device fan-out when the gate is closed");
  assert.equal(calls.dispatch.length, 1);
});

test("gate OPEN + resolvable device set: one sealForPeerDevice per device, to each device's inbox", async () => {
  const deviceSet = {
    deviceSetRecord: { devices: [
      { deviceId: "rez:dev:1", devicePublicKeyB64: "k1", inboxId: "inbox:dev1" },
      { deviceId: "rez:dev:2", devicePublicKeyB64: "k2", inboxId: "inbox:dev2" },
    ] },
    established: [{ peerDeviceId: "rez:dev:1", handshakeData: { x: 1 } }],
  };
  const { svc, calls } = makeHarness({ multiDeviceFanout: true, deviceSet });
  await svc.sendMessage({ threadId: THREAD_ID, payload: { text: "hello" } });

  assert.equal(calls.sealForPeer.length, 0, "no legacy single-device send when fanning out");
  assert.equal(calls.sealForPeerDevice.length, 2, "one seal per recipient device");
  const inboxes = calls.sealForPeerDevice.map((a) => a.deliverInboxId).sort();
  assert.deepEqual(inboxes, ["inbox:dev1", "inbox:dev2"]);
  // First-contact handshake is carried for the device with an established session.
  const dev1 = calls.sealForPeerDevice.find((a) => a.peerDeviceId === "rez:dev:1");
  assert.deepEqual(dev1.deviceHandshakeData, { x: 1 });
  assert.equal(calls.dispatch.length, 2, "fanned out to both device inboxes");
});

test("gate OPEN but the peer published NO device set: falls back to the legacy path", async () => {
  const { svc, calls } = makeHarness({ multiDeviceFanout: true, deviceSet: null });
  await svc.sendMessage({ threadId: THREAD_ID, payload: { text: "hello" } });
  assert.equal(calls.sealForPeerDevice.length, 0);
  assert.equal(calls.sealForPeer.length, 1, "no resolvable device set ⇒ legacy single-device send");
});

test("gate OPEN: a partial fan-out (one device's dispatch fails) is NOT reported as success (Audit P1)", async () => {
  const deviceSet = {
    deviceSetRecord: { devices: [
      { deviceId: "rez:dev:1", devicePublicKeyB64: "k1", inboxId: "inbox:dev1" },
      { deviceId: "rez:dev:2", devicePublicKeyB64: "k2", inboxId: "inbox:dev2" },
    ] },
    established: [],
  };
  const { svc, calls, sdk } = makeHarness({ multiDeviceFanout: true, deviceSet });
  // Make the second device's dispatch throw (a transient network failure before
  // the node could queue it — so the node will never retry it).
  sdk.mesh.dispatch = async (object, address) => {
    calls.dispatch.push({ object, address });
    if (address && address.inboxId === "inbox:dev2") throw new Error("network down");
    return { queued: false };
  };
  // The send must surface a failure (DEVICE_FANOUT_INCOMPLETE), not silently
  // report the message as sent because dev1 succeeded.
  await assert.rejects(
    () => svc.sendMessage({ threadId: THREAD_ID, payload: { text: "hello" } }),
    (err) => /fan-out incomplete/.test(err.message) || err.code === "DEVICE_FANOUT_INCOMPLETE",
  );
  // Both devices were attempted; dev1's deposit did go out (the durable home
  // dedups it on retry), so no double-deliver risk.
  assert.equal(calls.sealForPeerDevice.length, 2, "both devices attempted");
});

test("Audit R2 #4: a retry replays cached ciphertext only to the FAILED device — no re-encrypt, no re-dispatch to delivered", async () => {
  const deviceSet = {
    deviceSetRecord: { devices: [
      { deviceId: "rez:dev:1", devicePublicKeyB64: "k1", inboxId: "inbox:dev1" },
      { deviceId: "rez:dev:2", devicePublicKeyB64: "k2", inboxId: "inbox:dev2" },
    ] },
    established: [],
  };
  const { svc, calls, sdk } = makeHarness({ multiDeviceFanout: true, deviceSet });
  let dev2Attempts = 0;
  sdk.mesh.dispatch = async (object, address) => {
    calls.dispatch.push({ object, address });
    if (address && address.inboxId === "inbox:dev2") {
      dev2Attempts += 1;
      if (dev2Attempts === 1) throw new Error("network down"); // fail once, then succeed
    }
    return { queued: false };
  };

  // First attempt: dev2's dispatch throws ⇒ the whole send fails.
  await assert.rejects(
    () => svc.sendMessage({ threadId: THREAD_ID, messageId: "msg-retry", payload: { text: "hello" } }),
    (err) => err.code === "DEVICE_FANOUT_INCOMPLETE" || /fan-out incomplete/.test(err.message),
  );
  assert.equal(calls.sealForPeerDevice.length, 2, "first attempt sealed both devices once");
  assert.equal(calls.dispatch.length, 2, "first attempt dispatched both (dev2 threw)");

  // Retry the SAME messageId: dev1 is already delivered (skip — no re-seal, no
  // re-dispatch); dev2 replays its CACHED ciphertext (no re-seal) and now succeeds.
  await svc.sendMessage({ threadId: THREAD_ID, messageId: "msg-retry", payload: { text: "hello" } });

  assert.equal(calls.sealForPeerDevice.length, 2, "NO re-encryption on retry (still 2 total seals)");
  const dev1Seals = calls.sealForPeerDevice.filter((a) => a.peerDeviceId === "rez:dev:1").length;
  const dev2Seals = calls.sealForPeerDevice.filter((a) => a.peerDeviceId === "rez:dev:2").length;
  assert.equal(dev1Seals, 1, "dev1 sealed exactly once across both attempts");
  assert.equal(dev2Seals, 1, "dev2 sealed exactly once (retry replayed the cached bytes)");
  assert.equal(calls.dispatch.length, 3, "retry re-dispatched ONLY the failed device (2 + 1)");
  const dev1Dispatches = calls.dispatch.filter((d) => d.address && d.address.inboxId === "inbox:dev1").length;
  assert.equal(dev1Dispatches, 1, "the delivered device was NOT re-dispatched (no double receive-ratchet advance)");
});

test("Audit R3 #4: a retry AFTER a sender RESTART replays the cached ciphertext — no re-encrypt", async () => {
  const deviceSet = {
    deviceSetRecord: { devices: [
      { deviceId: "rez:dev:1", devicePublicKeyB64: "k1", inboxId: "inbox:dev1" },
      { deviceId: "rez:dev:2", devicePublicKeyB64: "k2", inboxId: "inbox:dev2" },
    ] },
    established: [],
  };
  // The durable store is the ONLY state shared across the simulated restart.
  const sp = makeStorageProvider();

  // --- Process 1: dev1 delivers, dev2's dispatch throws ⇒ the send fails. ---
  const h1 = makeHarness({ multiDeviceFanout: true, deviceSet, storageProvider: sp });
  h1.sdk.mesh.dispatch = async (object, address) => {
    h1.calls.dispatch.push({ object, address });
    if (address && address.inboxId === "inbox:dev2") throw new Error("network down");
    return { queued: false };
  };
  await assert.rejects(
    () => h1.svc.sendMessage({ threadId: THREAD_ID, messageId: "msg-restart", payload: { text: "hello" } }),
    (err) => err.code === "DEVICE_FANOUT_INCOMPLETE" || /fan-out incomplete/.test(err.message),
  );
  assert.equal(h1.calls.sealForPeerDevice.length, 2, "process 1 sealed both devices once");

  // --- SIMULATED RESTART: a brand-new service over the SAME durable store. The
  // in-memory Map is gone; only the persisted ciphertext + delivered marks remain.
  const h2 = makeHarness({ multiDeviceFanout: true, deviceSet, storageProvider: sp });
  // dev2 now succeeds.
  await h2.svc.sendMessage({ threadId: THREAD_ID, messageId: "msg-restart", payload: { text: "hello" } });

  assert.equal(h2.calls.sealForPeerDevice.length, 0,
    "the restarted process re-encrypted NOTHING — it replayed the persisted bytes / honored the persisted delivered mark");
  const dev1After = h2.calls.dispatch.filter((d) => d.address && d.address.inboxId === "inbox:dev1").length;
  const dev2After = h2.calls.dispatch.filter((d) => d.address && d.address.inboxId === "inbox:dev2").length;
  assert.equal(dev1After, 0, "the already-delivered device is skipped after restart (persisted deliveredOk)");
  assert.equal(dev2After, 1, "only the previously-failed device is re-dispatched, replaying its cached ciphertext");
});
