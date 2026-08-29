// M3 (plans/MOBILE_LIFECYCLE_ADAPTER_PLAN.md §7c) — runtime.renewLeaseIfDue:
// wake-time lease renewal derived from durable state + now, never from a
// timer that fired. The three frozen pins:
//   1. Lease state persists ONLY from the acceptance seam — the exact
//      delegation the provider accepted through the claim round-trip.
//   2. Due when remaining <= TTL/2 — the exact boundary RENEWS.
//   3. A failed renewal leaves the previous durable lease state intact, so
//      the next wake still derives "due".

import test from "node:test";
import assert from "node:assert/strict";

import { ChatServerBus } from "../src/server/app/ChatServerBus.js";
import { ServerRuntimeService } from "../src/server/services/ServerRuntimeService.js";

const INBOX = "rez:inbox:chat-server";
const QUIET_LOGGER = { log() {}, warn() {}, info() {}, error() {} };
const TTL = 1000;

// Stateful claim-store double with the M3 lease surface. createNodeDelegation
// stamps the window from the SAME clock the runtime uses, so tests control the
// timeline exactly.
function makeLeaseClaimStore({ ttlMs = TTL, clock }) {
  const store = {
    lease: null,
    async createReattestation(inboxId) {
      return { inboxId, claimantPublicKeyB64: "claimant-pub", claimedAtMs: clock(), claimSignatureB64: "claim-sig" };
    },
    async createNodeDelegation({ inboxId, nodeKeyId, nodePublicKeyB64, relayKeyId }) {
      const issuedAtMs = clock();
      return {
        inboxId, nodeKeyId, nodePublicKeyB64, relayKeyId,
        issuedAtMs, expiresAtMs: issuedAtMs + ttlMs, delegationSigB64: "deleg-sig",
      };
    },
    leaseState() {
      return store.lease ? { ...store.lease } : null;
    },
    async recordAcceptedLease({ issuedAtMs, expiresAtMs, retentionClass }) {
      store.lease = { issuedAtMs, expiresAtMs, retentionClass };
      return { ...store.lease };
    },
  };
  return store;
}

function makeSdk() {
  const state = { claims: 0, failClaims: false };
  const sdk = {
    async connect() {},
    async close() {},
    connectivity: { onReconnected() { return () => {}; } },
    getSessionInfo() {
      return { nodeKeyId: "node-key", nodePublicKeyB64: "node-pub", relayKeyId: "relay-key", capabilities: {} };
    },
    async sendRequest() {
      if (state.failClaims) {
        const err = new Error("NOT_READY");
        err.code = "NOT_READY";
        err.retryable = true;
        throw err;
      }
      state.claims += 1;
      return { body: {} };
    },
    subscriptions: { onMailboxDeposited() { return () => {}; } },
    mailbox: { async ack() {} },
  };
  return { sdk, state };
}

function makeRuntime({ sdk, claimStore, clock }) {
  const bus = new ChatServerBus({ config: {}, logger: QUIET_LOGGER });
  bus.services.inboundPipeline = { submit: async () => ({ status: "noop" }) };
  const svc = new ServerRuntimeService({
    bus,
    identity: { accountId: "rez:acct:m3", deviceId: "dev:m3", publicKeyB64: "p", privateKeyB64: "s" },
    uplinks: ["ws://node"],
    sdk,
    inboxClaimant: { inboxId: INBOX, claimStore },
    clock,
    logger: QUIET_LOGGER,
  });
  return { svc, bus };
}

test("M3: the full lifecycle — acceptance-seam persist at bind, TTL/2 boundary, renewal, failed-renewal intactness", async () => {
  let nowMs = 0;
  const clock = () => nowMs;
  const { sdk, state } = makeSdk();
  const claimStore = makeLeaseClaimStore({ clock });
  const { svc, bus } = makeRuntime({ sdk, claimStore, clock });

  // Bind at t=0: the ACCEPTED delegation is what gets persisted (pin 1).
  await svc.connect();
  assert.equal(state.claims, 1);
  assert.deepEqual(claimStore.lease, { issuedAtMs: 0, expiresAtMs: TTL, retentionClass: "transient" });

  // t=499: remaining 501 > 500 — not due; no wire round-trip.
  nowMs = 499;
  let result = await bus.call("runtime", "renewLeaseIfDue", {});
  assert.deepEqual(result, { renewed: false, reason: "not-due", expiresAtMs: TTL });
  assert.equal(state.claims, 1, "no claim sent when not due");

  // t=500: remaining == TTL/2 exactly — the boundary RENEWS (pin 2).
  nowMs = 500;
  result = await bus.call("runtime", "renewLeaseIfDue", {});
  assert.equal(result.renewed, true);
  assert.equal(result.expiresAtMs, 500 + TTL);
  assert.equal(state.claims, 2, "the renewal is the claim/reattest round-trip");
  assert.deepEqual(claimStore.lease, { issuedAtMs: 500, expiresAtMs: 1500, retentionClass: "transient" });

  // t=1200 (due) but the wire op fails: the attempt REJECTS and the previous
  // durable lease is untouched (pin 3) — the next wake still derives "due".
  nowMs = 1200;
  state.failClaims = true;
  await assert.rejects(svc.renewLeaseIfDue(), (err) => err.retryable === true);
  assert.deepEqual(claimStore.lease, { issuedAtMs: 500, expiresAtMs: 1500, retentionClass: "transient" },
    "a failed renewal never advances the client's view of its lease");

  // Network back: the SAME derivation renews and records the accepted window.
  state.failClaims = false;
  result = await svc.renewLeaseIfDue();
  assert.equal(result.renewed, true);
  assert.deepEqual(claimStore.lease, { issuedAtMs: 1200, expiresAtMs: 2200, retentionClass: "transient" });
});

test("M3: missing lease state derives as DUE — renewing is the safe direction and repopulates it", async () => {
  let nowMs = 0;
  const clock = () => nowMs;
  const { sdk, state } = makeSdk();
  const claimStore = makeLeaseClaimStore({ clock });
  const { svc } = makeRuntime({ sdk, claimStore, clock });
  await svc.connect();

  // Simulate a pre-M3 record / an earlier failed persist: state vanished.
  claimStore.lease = null;
  nowMs = 100; // nowhere near any threshold — absence alone must renew
  const result = await svc.renewLeaseIfDue();
  assert.equal(result.renewed, true);
  assert.equal(state.claims, 2);
  assert.deepEqual(claimStore.lease, { issuedAtMs: 100, expiresAtMs: 100 + TTL, retentionClass: "transient" });
});

test("M3: self-deciding no-ops — not connected, and a claim store without the lease surface", async () => {
  let nowMs = 0;
  const clock = () => nowMs;

  // Not connected: renewal cannot run (ensureLive precedes it in converge).
  {
    const { sdk } = makeSdk();
    sdk.connect = async () => {
      const err = new Error("UNREACHABLE");
      err.retryable = true;
      throw err;
    };
    const claimStore = makeLeaseClaimStore({ clock });
    const { svc } = makeRuntime({ sdk, claimStore, clock });
    await assert.rejects(svc.connect(), (err) => err.retryable === true);
    assert.deepEqual(await svc.renewLeaseIfDue(), { renewed: false, reason: "not-connected" });
  }

  // A pre-M3 claim-store double (no leaseState): declared unsupported, never
  // silently treated as healthy or endlessly re-claimed.
  {
    const { sdk, state } = makeSdk();
    const legacyStore = {
      async createReattestation(inboxId) {
        return { inboxId, claimantPublicKeyB64: "claimant-pub", claimedAtMs: clock(), claimSignatureB64: "claim-sig" };
      },
      async createNodeDelegation({ inboxId, nodeKeyId, nodePublicKeyB64, relayKeyId }) {
        return { inboxId, nodeKeyId, nodePublicKeyB64, relayKeyId, issuedAtMs: clock(), expiresAtMs: clock() + TTL, delegationSigB64: "deleg-sig" };
      },
    };
    const { svc } = makeRuntime({ sdk, claimStore: legacyStore, clock });
    await svc.connect();
    const claimsAfterConnect = state.claims;
    assert.deepEqual(await svc.renewLeaseIfDue(), { renewed: false, reason: "lease-state-unsupported" });
    assert.equal(state.claims, claimsAfterConnect);
  }
});
