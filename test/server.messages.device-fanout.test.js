import test from "node:test";
import assert from "node:assert/strict";
import { ServerMessagesService } from "../src/server/services/ServerMessagesService.js";

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

function makeHarness({ multiDeviceFanout = false, deviceSet = null } = {}) {
  const calls = { sealForPeer: [], sealForPeerDevice: [], dispatch: [] };
  const sdk = {
    getIdentity: () => ({ localInboxId: "inbox:owner" }),
    sealForPeer: async (a) => { calls.sealForPeer.push(a); return { object: { sf: true }, address: { inboxId: a.deliverInboxId } }; },
    sealForPeerDevice: async (a) => { calls.sealForPeerDevice.push(a); return { object: { sfd: true }, address: { inboxId: a.deliverInboxId } }; },
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
  const svc = new ServerMessagesService({ bus, threadStore, threadIndex, groupStore, ownerAccountId: OWNER, clock: () => 1000 });
  return { svc, calls };
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
