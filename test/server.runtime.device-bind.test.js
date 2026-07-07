import test from "node:test";
import assert from "node:assert/strict";
import { ServerRuntimeService } from "../src/server/services/ServerRuntimeService.js";

// S2.5 Slice 5 leaf 3 — the chat-side `device.bind` wiring on connect(). After
// the inbox claim, ServerRuntimeService presents this device's proven key to the
// home so the durable cursor keys on the SIGNED self-cert deviceId. This pins the
// THREE gates that keep the shipped (fs / DO-relay) delivery path unchanged and
// the best-effort discipline (a bind failure never breaks connect). The crypto +
// frame shape are proven un-mocked in rez-sdk devices.capability.test.js.

const INBOX = "rez:inbox:chat-server";

function makeBus() {
  const handlers = new Map();
  return {
    runtime: {},
    stores: {},
    // MailboxPushBridge.attach requires an inboundPipeline with submit(); no
    // deposit frame arrives in this test, so submit is never actually called.
    services: { inboundPipeline: { submit() {} } },
    resolveReady: { runtime() {} },
    on(name, fn) {
      if (!handlers.has(name)) handlers.set(name, new Set());
      handlers.get(name).add(fn);
      return () => handlers.get(name).delete(fn);
    },
    emit() {},
    registerFunction() {},
    call() { return Promise.resolve(null); },
  };
}

function makeInboxClaimant() {
  return {
    inboxId: INBOX,
    claimStore: {
      async createReattestation(inboxId) {
        return { inboxId, claimantPublicKeyB64: "claimant-pub", claimedAtMs: 1000, claimSignatureB64: "claim-sig" };
      },
      async createNodeDelegation({ inboxId, nodeKeyId, nodePublicKeyB64, relayKeyId }) {
        return { inboxId, nodeKeyId, nodePublicKeyB64, relayKeyId, issuedAtMs: 1000, expiresAtMs: 9_000_000_000_000, delegationSigB64: "deleg-sig" };
      },
    },
  };
}

function makeSdk({ durable = true, deviceKeyPub = "device-pub", bindImpl = null, gateOpen = false } = {}) {
  const calls = { bind: [], buildReg: 0, buildBinding: [], sendRequest: [] };
  const REGISTRATION = { __kind: "DeviceRegistrationV1" };
  const sdk = {
    async connect() {},
    onState() { return () => {}; },
    getSessionInfo() {
      return {
        nodeKeyId: "node-key",
        nodePublicKeyB64: "node-pub",
        relayKeyId: "relay-key",
        capabilities: { durableInbox: durable === true, multiDeviceFanout: gateOpen === true, localInboxId: INBOX },
      };
    },
    async sendRequest(req) { calls.sendRequest.push(req); return { body: {} }; },
    subscriptions: { onMailboxDeposited() { return () => {}; } },
    mailbox: { ack() {} },
    identity: {
      getDeviceKeyPublicKeyB64() { return deviceKeyPub; },
      getDeviceId() { return "rez:dev:self-cert"; },
      async buildDeviceRegistration() { calls.buildReg += 1; return REGISTRATION; },
      async buildDeviceInboxBinding({ inboxId } = {}) { calls.buildBinding.push(inboxId); return { __kind: "DeviceInboxBindingV1", inboxId }; },
    },
    devices: {
      async bind(args) {
        calls.bind.push(args);
        if (typeof bindImpl === "function") return bindImpl(args);
        return { inboxId: INBOX, deviceId: "rez:dev:self-cert" };
      },
    },
  };
  return { sdk, calls, REGISTRATION };
}

function makeService({ sdk, identity = null }) {
  const bus = makeBus();
  const errors = [];
  const logger = { error: (...a) => errors.push(a), warn() {}, info() {}, log() {} };
  const svc = new ServerRuntimeService({
    bus,
    identity: identity || { accountId: "rez:acct:chat", deviceId: "rez:dev:self-cert", publicKeyB64: "p", privateKeyB64: "s" },
    uplinks: ["ws://node"],
    sdk,
    inboxClaimant: makeInboxClaimant(),
    logger,
  });
  return { svc, errors, bus };
}

// The S10 delegated identity shape: NO account private key; device key +
// cert chain instead (the session cert chain IS the registration).
const DELEGATED_IDENTITY = {
  accountId: "rez:acct:chat",
  deviceId: "rez:dev:self-cert",
  publicKeyB64: "p",
  privateKeyB64: null,
  deviceKey: { publicKeyB64: "device-pub", privateKeyB64: "device-priv" },
  certChain: [{ certId: "rez:cap:stub" }],
};

test("durable node + device key: device.bind is called once with the built records, bound to the claimed inbox", async () => {
  const { sdk, calls, REGISTRATION } = makeSdk({ durable: true, deviceKeyPub: "device-pub" });
  const { svc } = makeService({ sdk });
  await svc.connect();

  assert.equal(calls.sendRequest.length, 1, "inbox claim sent");
  assert.equal(calls.bind.length, 1, "device.bind called once");
  assert.equal(calls.buildReg, 1);
  assert.deepEqual(calls.buildBinding, [INBOX], "binding built for the claimed inbox");
  assert.equal(calls.bind[0].deviceRegistration, REGISTRATION, "the built registration is forwarded verbatim");
  assert.deepEqual(calls.bind[0].deviceInboxBinding, { __kind: "DeviceInboxBindingV1", inboxId: INBOX });
});

test("R3 #3: gate OPEN bridges multiDeviceFanout onto bus.runtime (send-path gate can engage)", async () => {
  const { sdk } = makeSdk({ durable: true, gateOpen: true, deviceKeyPub: "device-pub" });
  const { svc, bus } = makeService({ sdk });
  await svc.connect();
  assert.equal(bus.runtime.multiDeviceFanout, true, "the negotiated E6 capability reached the runtime");
});

test("R3 #3: gate CLOSED leaves bus.runtime.multiDeviceFanout false (legacy single-device send)", async () => {
  const { sdk } = makeSdk({ durable: true, gateOpen: false, deviceKeyPub: "device-pub" });
  const { svc, bus } = makeService({ sdk });
  await svc.connect();
  assert.equal(bus.runtime.multiDeviceFanout, false, "gate closed ⇒ sender stays on the legacy path");
});

test("non-durable node: device.bind is NOT called (shipped fs / DO-relay path unchanged)", async () => {
  const { sdk, calls } = makeSdk({ durable: false });
  const { svc } = makeService({ sdk });
  await svc.connect();
  assert.equal(calls.sendRequest.length, 1, "inbox claim still sent");
  assert.equal(calls.bind.length, 0, "no device.bind against a node without durableInbox");
});

test("no device key (legacy keystore): device.bind is NOT called", async () => {
  const { sdk, calls } = makeSdk({ durable: true, deviceKeyPub: null });
  const { svc } = makeService({ sdk });
  await svc.connect();
  assert.equal(calls.bind.length, 0, "no device.bind without a device key to prove");
});

test("device.bind failure is logged but never breaks connect (best-effort; E6 gated)", async () => {
  const { sdk, calls } = makeSdk({ durable: true, bindImpl: () => { throw Object.assign(new Error("boom"), { code: "INVALID_SIGNATURE" }); } });
  const { svc, errors } = makeService({ sdk });
  await svc.connect();
  assert.equal(svc.connected, true, "connect succeeds despite the bind failure");
  assert.equal(calls.bind.length, 1);
  assert.equal(errors.length, 1, "the failure is logged, not swallowed");
  assert.match(errors[0][0], /device\.bind failed/);
});

test("SDK without the devices/identity capabilities (older client / fake): no-op, connect succeeds", async () => {
  const { sdk } = makeSdk({ durable: true });
  delete sdk.devices;
  const { svc } = makeService({ sdk });
  await svc.connect();
  assert.equal(svc.connected, true);
});

// --- Audit R2 #6: device.bind is a READINESS GATE when the node advertises the
// open E6 gate (multiDeviceFanout). The claim no-ops the cursor there, so a
// connection that cannot bind has NO durable cursor and must NOT report ready.

test("gate OPEN + device key: device.bind succeeds, connect is ready", async () => {
  const { sdk, calls } = makeSdk({ durable: true, gateOpen: true, deviceKeyPub: "device-pub" });
  const { svc } = makeService({ sdk });
  await svc.connect();
  assert.equal(svc.connected, true);
  assert.equal(calls.bind.length, 1, "device.bind called under the open gate");
});

test("gate OPEN + device.bind FAILS: connect throws (no ready connection without a cursor)", async () => {
  const { sdk, calls } = makeSdk({ durable: true, gateOpen: true, bindImpl: () => { throw Object.assign(new Error("boom"), { code: "DEVICE_LIMIT" }); } });
  const { svc, errors } = makeService({ sdk });
  await assert.rejects(() => svc.connect(), /boom/);
  assert.equal(svc.connected, false, "connect did not report ready");
  assert.equal(calls.bind.length, 1, "bind was attempted");
  assert.ok(errors.length >= 1, "the failure was logged before rethrow");
});

test("gate OPEN + no device key: connect throws (cannot prove a device for a cursor)", async () => {
  const { sdk, calls } = makeSdk({ durable: true, gateOpen: true, deviceKeyPub: null });
  const { svc } = makeService({ sdk });
  await assert.rejects(() => svc.connect(), /no device key/);
  assert.equal(svc.connected, false);
  assert.equal(calls.bind.length, 0, "bind not attempted without a device key");
});

// --- S10: a DELEGATED identity binds with the deviceInboxBinding ONLY — its
// session cert chain IS the registration (S8 node dual-mode). Building the
// account-signed DeviceRegistrationV1 needs B, which a delegated device does
// not hold, so buildDeviceRegistration must never be invoked.

test("S10 delegated + gate OPEN: bind sends a NULL registration and never builds one; connect is ready", async () => {
  const { sdk, calls } = makeSdk({ durable: true, gateOpen: true, deviceKeyPub: "device-pub" });
  const { svc } = makeService({ sdk, identity: DELEGATED_IDENTITY });
  await svc.connect();
  assert.equal(svc.connected, true);
  assert.equal(calls.bind.length, 1, "device.bind called");
  assert.equal(calls.buildReg, 0, "buildDeviceRegistration never invoked on a delegated identity");
  assert.equal(calls.bind[0].deviceRegistration, null, "binding-only bind");
  assert.deepEqual(calls.bind[0].deviceInboxBinding, { __kind: "DeviceInboxBindingV1", inboxId: INBOX });
});

test("S10 delegated + gate CLOSED: same binding-only call, best-effort semantics preserved", async () => {
  const { sdk, calls } = makeSdk({
    durable: true,
    gateOpen: false,
    deviceKeyPub: "device-pub",
    bindImpl: () => { throw Object.assign(new Error("boom"), { code: "SERVICE_UNAVAILABLE" }); },
  });
  const { svc, errors } = makeService({ sdk, identity: DELEGATED_IDENTITY });
  await svc.connect();
  assert.equal(svc.connected, true, "gate closed: a bind failure never breaks connect");
  assert.equal(calls.buildReg, 0);
  assert.equal(calls.bind.length, 1);
  assert.equal(calls.bind[0].deviceRegistration, null);
  assert.equal(errors.length, 1, "logged, not swallowed");
});
