import test from "node:test";
import assert from "node:assert/strict";
import { ServerPeerLinkProtocolService } from "../src/server/services/ServerPeerLinkProtocolService.js";

// Audit P1 — the first-contact per-device handshake is carried IN-BAND in the
// deposit envelope (bodyObj.deviceHandshake). ServerPeerLinkProtocolService must
// establish the responder device session from it BEFORE decrypt, idempotently
// (never re-run on a re-delivered first message) and best-effort (a failure is
// logged, not thrown — the deposit stays buffered to retry). The full crypto
// round-trip is proven un-mocked in rez-sdk peer-link.service.device-set.test.js;
// here we pin the receiver wiring.

function makeBus(peerLinks) {
  return {
    runtime: { peerLinks },
    on() { return () => {}; },
    emit() {},
    registerFunction() {},
    call() { return Promise.resolve(null); },
  };
}

function makeSvc(peerLinks) {
  const errors = [];
  const logger = { error: (...a) => errors.push(a), warn() {}, info() {}, log() {} };
  const svc = new ServerPeerLinkProtocolService({ bus: makeBus(peerLinks), ownerAccountId: "rez:acct:me", logger });
  return { svc, errors };
}

const HS = { senderAccountId: "rez:acct:bob", senderDeviceId: "rez:dev:bob1", handshakeData: { x: 1 } };

test("establishes the responder against the sender when no session exists yet", async () => {
  const calls = { complete: [], has: [] };
  const peerLinks = {
    hasDeviceSessions: () => true,
    async hasDeviceSession(a) { calls.has.push(a); return false; },
    async completeDeviceSetResponder(a) { calls.complete.push(a); },
  };
  const { svc } = makeSvc(peerLinks);
  await svc._establishDeviceResponderFromHandshake(peerLinks, HS);
  assert.deepEqual(calls.has, [{ peerAccountId: "rez:acct:bob", peerDeviceId: "rez:dev:bob1" }]);
  assert.equal(calls.complete.length, 1);
  assert.deepEqual(calls.complete[0], { peerAccountId: "rez:acct:bob", peerDeviceId: "rez:dev:bob1", handshakeData: { x: 1 } });
});

test("idempotent: a session that already exists is NOT re-established", async () => {
  const calls = { complete: 0 };
  const peerLinks = {
    hasDeviceSessions: () => true,
    async hasDeviceSession() { return true; },
    async completeDeviceSetResponder() { calls.complete += 1; },
  };
  const { svc } = makeSvc(peerLinks);
  await svc._establishDeviceResponderFromHandshake(peerLinks, HS);
  assert.equal(calls.complete, 0, "no re-establishment when a device session already exists");
});

test("no-op for an account with no per-device sessions (legacy)", async () => {
  let complete = 0;
  const peerLinks = {
    hasDeviceSessions: () => false,
    async hasDeviceSession() { return false; },
    async completeDeviceSetResponder() { complete += 1; },
  };
  const { svc } = makeSvc(peerLinks);
  await svc._establishDeviceResponderFromHandshake(peerLinks, HS);
  assert.equal(complete, 0);
});

test("best-effort: a completeDeviceSetResponder failure is logged, not thrown", async () => {
  const peerLinks = {
    hasDeviceSessions: () => true,
    async hasDeviceSession() { return false; },
    async completeDeviceSetResponder() { throw new Error("prekey missing"); },
  };
  const { svc, errors } = makeSvc(peerLinks);
  await svc._establishDeviceResponderFromHandshake(peerLinks, HS); // must not throw
  assert.equal(errors.length, 1, "the failure is logged");
  assert.match(String(errors[0][0]), /device responder establish failed/);
});

test("ignores a malformed in-band handshake (missing fields)", async () => {
  let complete = 0;
  const peerLinks = {
    hasDeviceSessions: () => true,
    async hasDeviceSession() { return false; },
    async completeDeviceSetResponder() { complete += 1; },
  };
  const { svc } = makeSvc(peerLinks);
  await svc._establishDeviceResponderFromHandshake(peerLinks, { senderAccountId: "rez:acct:bob" }); // no deviceId/handshakeData
  assert.equal(complete, 0);
});
