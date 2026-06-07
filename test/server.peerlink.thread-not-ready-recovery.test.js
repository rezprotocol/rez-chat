import test from "node:test";
import assert from "node:assert/strict";

import { ServerPeerLinkProtocolService } from "../src/server/services/ServerPeerLinkProtocolService.js";

// Phase 2 recipient-side recovery — the GATE. When decryptDirectMessageAnyPeer
// reports a total miss (THREAD_NOT_READY) with state-attributed
// recoveryCandidates, the chat-server triggers a rehandshake ONLY when exactly
// one candidate has crossed the threshold. Zero or ambiguous (>1) candidates
// are left to retry — the opaque packet cannot identify its sender, so we never
// guess. This test spies on _triggerRehandshake to assert the gate decision; the
// real SDK requestRehandshake → dispatch wiring of _triggerRehandshake itself is
// covered end-to-end by server.peerlink.rehandshake-trigger.test.js.

function makeFakeBus({ runtime } = {}) {
  return {
    runtime,
    services: {},
    stores: {},
    on() { return () => {}; },
    emit() {},
    registerFunction() {},
    call() { return Promise.resolve(null); },
  };
}

function e2eeDeposit() {
  const body = { e2ee: 1, v: 1, payload: "opaque-ciphertext" };
  const ciphertextB64 = Buffer.from(JSON.stringify(body)).toString("base64");
  return { body: { eventId: "evt:1", mailboxId: "inbox:owner", ciphertextB64 } };
}

function makeService({ recoveryCandidates }) {
  const calls = [];
  const peerLinks = {
    async decryptDirectMessageAnyPeer() {
      const err = new Error("No peer link could decrypt packet");
      err.code = "THREAD_NOT_READY";
      err.recoveryCandidates = recoveryCandidates;
      throw err;
    },
  };
  const bus = makeFakeBus({ runtime: { peerLinks, sdk: { mesh: {} } } });
  const service = new ServerPeerLinkProtocolService({
    bus,
    ownerAccountId: "rez:acct:owner",
    logger: { log() {}, info() {}, warn() {}, error() {} },
  });
  // Spy on the trigger so the gate decision is observed synchronously (the real
  // trigger dispatches async fire-and-forget; its wiring is tested separately).
  service._triggerRehandshake = ({ peerAccountId }) => { calls.push({ peerAccountId }); };
  return { service, calls };
}

test("exactly one eligible candidate triggers a single rehandshake", async () => {
  const { service, calls } = makeService({
    recoveryCandidates: [
      { peerAccountId: "rez:acct:bob", peerLinkId: "pl_bob", consecutiveMisses: 3, rehandshakeNeeded: true },
      { peerAccountId: "rez:acct:dave", peerLinkId: "pl_dave", consecutiveMisses: 1, rehandshakeNeeded: false },
    ],
  });
  const result = await service.processDeposit(e2eeDeposit());
  assert.deepEqual(result, { consumed: false, decryptOk: false, reason: "thread-not-ready" });
  assert.equal(calls.length, 1, "one rehandshake triggered");
  assert.equal(calls[0].peerAccountId, "rez:acct:bob");
});

test("zero eligible candidates triggers no rehandshake", async () => {
  const { service, calls } = makeService({
    recoveryCandidates: [
      { peerAccountId: "rez:acct:bob", peerLinkId: "pl_bob", consecutiveMisses: 1, rehandshakeNeeded: false },
    ],
  });
  const result = await service.processDeposit(e2eeDeposit());
  assert.equal(result.reason, "thread-not-ready");
  assert.equal(calls.length, 0, "no rehandshake when nothing crossed the threshold");
});

test("ambiguous (>1) eligible candidates triggers no rehandshake", async () => {
  const { service, calls } = makeService({
    recoveryCandidates: [
      { peerAccountId: "rez:acct:bob", peerLinkId: "pl_bob", consecutiveMisses: 3, rehandshakeNeeded: true },
      { peerAccountId: "rez:acct:dave", peerLinkId: "pl_dave", consecutiveMisses: 4, rehandshakeNeeded: true },
    ],
  });
  const result = await service.processDeposit(e2eeDeposit());
  assert.equal(result.reason, "thread-not-ready");
  assert.equal(calls.length, 0, "no guessing between multiple eligible candidates");
});

test("missing recoveryCandidates is tolerated (legacy THREAD_NOT_READY) — no throw, no trigger", async () => {
  const { service, calls } = makeService({ recoveryCandidates: undefined });
  const result = await service.processDeposit(e2eeDeposit());
  assert.equal(result.reason, "thread-not-ready");
  assert.equal(calls.length, 0);
});
