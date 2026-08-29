// M2 (plans/MOBILE_LIFECYCLE_ADAPTER_PLAN.md) — the two directive-addressable
// liveness seams the mobile adapter schedules:
//
//   runtime.ensureLive — the app-level liveness kick (T2). First connect
//   incomplete → run it (bind included); pool reconnecting/offline →
//   connectivity.connectNow() (backoff cancelled, attempt serialized with the
//   pool's own machinery); already live → no-op, the caller's drain is the
//   liveness probe.
//
//   inbox.drain — pull on demand (T3). A wake whose socket survived (or is a
//   not-yet-detected zombie) forces a drain instead of waiting for the 30s
//   interval, which does not fire while suspended.

import test from "node:test";
import assert from "node:assert/strict";

import { ChatServerBus } from "../src/server/app/ChatServerBus.js";
import { ServerRuntimeService } from "../src/server/services/ServerRuntimeService.js";
import { InboxCatchupService } from "../src/server/services/InboxCatchupService.js";

const INBOX = "rez:inbox:chat-server";
const QUIET_LOGGER = { log() {}, warn() {}, info() {}, error() {} };

function retryableErr(code) {
  const err = new Error(code || "UNREACHABLE");
  err.code = code || "UNREACHABLE";
  err.retryable = true;
  return err;
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

// Fake sdk with a network toggle, pool-state emission, and a recording
// connectivity.connectNow (successful kicks also fire the reconnected
// handlers, mirroring the real pool's awaited restoration contract).
function makeSdk() {
  const state = { online: true, connectAttempts: 0, claims: [], listed: 0, connectNowCalls: 0 };
  const reconnectHandlers = [];
  let poolStateHandler = null;
  const sdk = {
    async connect() {
      state.connectAttempts += 1;
      if (!state.online) throw retryableErr("UNREACHABLE");
    },
    async close() {},
    onPoolState(handler) {
      poolStateHandler = handler;
      return () => { poolStateHandler = null; };
    },
    connectivity: {
      onReconnected(handler) {
        reconnectHandlers.push(handler);
        return () => {
          const i = reconnectHandlers.indexOf(handler);
          if (i >= 0) reconnectHandlers.splice(i, 1);
        };
      },
      async connectNow() {
        state.connectNowCalls += 1;
        if (!state.online) throw retryableErr("UNREACHABLE");
        for (const handler of [...reconnectHandlers]) await handler();
      },
    },
    getSessionInfo() {
      if (!state.online) return null;
      return { nodeKeyId: "node-key", nodePublicKeyB64: "node-pub", relayKeyId: "relay-key", capabilities: {} };
    },
    async sendRequest(req) { state.claims.push(req); return { body: {} }; },
    subscriptions: { onMailboxDeposited() { return () => {}; } },
    mailbox: {
      async list() {
        if (!state.online) throw retryableErr("NOT_READY");
        state.listed += 1;
        return { items: [] };
      },
      async fetch() { throw new Error("unexpected fetch: list returned no items"); },
      async ack() {},
    },
  };
  return {
    sdk,
    state,
    emitPoolState(payload) {
      if (!poolStateHandler) throw new Error("no pool state handler registered");
      poolStateHandler(payload);
    },
  };
}

function makeRuntime(sdk) {
  const bus = new ChatServerBus({ config: {}, logger: QUIET_LOGGER });
  bus.services.inboundPipeline = { submit: async () => ({ status: "noop" }) };
  const svc = new ServerRuntimeService({
    bus,
    identity: { accountId: "rez:acct:m2", deviceId: "dev:m2", publicKeyB64: "p", privateKeyB64: "s" },
    uplinks: ["ws://node"],
    sdk,
    inboxClaimant: makeInboxClaimant(),
    logger: QUIET_LOGGER,
  });
  return { svc, bus };
}

// ---- runtime.ensureLive ----

test("M2 ensureLive: first connect incomplete (offline boot) → runs the full connect, bind included", async () => {
  const { sdk, state } = makeSdk();
  state.online = false;
  const { svc, bus } = makeRuntime(sdk);
  await assert.rejects(svc.connect(), (err) => err.retryable === true);

  state.online = true;
  const result = await bus.call("runtime", "ensureLive", {});
  assert.deepEqual(result, { live: true, action: "connected" });
  assert.equal(svc.connected, true);
  assert.equal(state.claims.length, 1, "the bind (inbox claim) ran");
});

test("M2 ensureLive: still offline → rethrows retryable so a wake sequence can short-circuit", async () => {
  const { sdk, state } = makeSdk();
  state.online = false;
  const { svc } = makeRuntime(sdk);
  await assert.rejects(svc.connect(), (err) => err.retryable === true);
  await assert.rejects(svc.ensureLive(), (err) => err.retryable === true);
  assert.equal(svc.connected, false);
});

test("M2 ensureLive: live session → no-op; the drain is the liveness probe, not a redundant reconnect", async () => {
  const { sdk, state } = makeSdk();
  const { svc } = makeRuntime(sdk);
  await svc.connect();
  const attemptsAfterConnect = state.connectAttempts;

  const result = await svc.ensureLive();
  assert.deepEqual(result, { live: true, action: "none" });
  assert.equal(state.connectNowCalls, 0, "no kick issued");
  assert.equal(state.connectAttempts, attemptsAfterConnect, "no reconnect churn");
});

test("M2 ensureLive: pool reports offline → connectivity.connectNow() kicks the backoff and the restoration hook replays the bind", async () => {
  const { sdk, state, emitPoolState } = makeSdk();
  const { svc } = makeRuntime(sdk);
  await svc.connect();
  const claimsAfterConnect = state.claims.length;

  emitPoolState({ phase: "offline", reason: "socket died during suspension" });
  const result = await svc.ensureLive();

  assert.deepEqual(result, { live: true, action: "reconnected" });
  assert.equal(state.connectNowCalls, 1, "exactly one kick");
  assert.equal(state.claims.length, claimsAfterConnect + 1, "the restoration hook replayed the inbox claim");
  assert.equal(svc.connected, true);
});

test("M2 ensureLive: pool offline and the kick fails (still no network) → rejects, no false liveness", async () => {
  const { sdk, state, emitPoolState } = makeSdk();
  const { svc } = makeRuntime(sdk);
  await svc.connect();

  emitPoolState({ phase: "offline", reason: "airplane mode" });
  state.online = false;
  await assert.rejects(svc.ensureLive(), (err) => err.retryable === true);
  assert.equal(state.connectNowCalls, 1);
});

// ---- inbox.drain ----

test("M2 inbox.drain: the directive forces a drain and reports caught-up", async () => {
  const { sdk, state } = makeSdk();
  const bus = new ChatServerBus({ config: {}, logger: QUIET_LOGGER });
  bus.runtime.sdk = sdk;
  const events = [];
  bus.on("inbox.caughtup", (payload) => events.push(payload));
  const svc = new InboxCatchupService({
    bus,
    inboxClaimant: makeInboxClaimant(),
    inboundPipeline: { submit: async () => ({ status: "noop" }) },
    periodicDrainMs: 0,
    logger: QUIET_LOGGER,
  });

  await bus.call("inbox", "drain", {});
  assert.equal(state.listed, 1, "the drain listed the mailbox");
  assert.equal(events.length, 1, "inbox.caughtup emitted");
  assert.equal(events[0].mailboxId, INBOX);
  await svc.stop();
});

test("M2 inbox.drain: concurrent directive calls coalesce (one extra pass, never parallel listing)", async () => {
  const { sdk, state } = makeSdk();
  let release = null;
  const gate = new Promise((resolve) => { release = resolve; });
  const realList = sdk.mailbox.list;
  sdk.mailbox.list = async (...args) => { await gate; return realList(...args); };
  const bus = new ChatServerBus({ config: {}, logger: QUIET_LOGGER });
  bus.runtime.sdk = sdk;
  const svc = new InboxCatchupService({
    bus,
    inboxClaimant: makeInboxClaimant(),
    inboundPipeline: { submit: async () => ({ status: "noop" }) },
    periodicDrainMs: 0,
    logger: QUIET_LOGGER,
  });

  const first = bus.call("inbox", "drain", {});
  const second = bus.call("inbox", "drain", {});
  const third = bus.call("inbox", "drain", {});
  release();
  await Promise.all([first, second, third]);

  assert.equal(state.listed, 2, "one in-flight pass + one coalesced follow-up — not three");
  await svc.stop();
});
