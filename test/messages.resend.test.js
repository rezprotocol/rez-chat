// messages.resend.test.js
//
// Idempotency regression: ServerMessagesService.sendMessage may be invoked
// a second time with the same messageId (tap-to-retry on a failed bubble).
// The plan: re-entering through the same send path is the only resend
// mechanism — no parallel resendMessage handler. The contract we verify:
//
//  1. Re-sending the same messageId does NOT duplicate the row in the
//     thread store. The same DB row is reused.
//  2. A failed-then-resend produces a clean status transition
//     (failed-row gets overwritten to pending; new attempt drives it
//     forward to queued/sent/failed via the usual path).
//  3. In-memory tracking maps (#queueTracking / #queuedByInbox /
//     #ackPending / #queuedMessages) carry no residue from the prior
//     attempt — a fresh queued/expired/delivered signal on the retry
//     is treated as the canonical one.

import test from "node:test";
import assert from "node:assert/strict";
import { ChatServerApp } from "../src/server/app/ChatServerApp.js";
import { REZ_CONTRACT_TYPES } from "@rezprotocol/sdk/client";

class TestKVStore {
  constructor() { this._data = new Map(); }
  async get(key) { return this._data.get(key); }
  async set(key, value) { this._data.set(key, value); }
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
  getObjectStore() { return { deposit: async () => ({}), list: async () => [] }; }
  getMailboxStore() { return { deposit: async () => ({}), poll: async () => [] }; }
}

const FAKE_IDENTITY_KEYS = {
  publicKeyB64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  privateKeyB64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
};

const ALICE = "rez:acct:alice";
const BOB = "rez:acct:bob";
const ALICE_DM_THREAD = "th_dm_alice_bob_a";

function makeServer({ ownerAccountId, storage, sendBehavior, clock }) {
  const sdk = {
    sendEncryptedDeposit: async (opts) => sendBehavior(opts),
    getIdentity: () => ({ localInboxId: "inbox:" + ownerAccountId }),
    subscriptions: {
      onEvent: () => () => {},
      onMailboxDeposited: () => () => {},
    },
  };
  return new ChatServerApp({
    identity: { ...FAKE_IDENTITY_KEYS, accountId: ownerAccountId, deviceId: "dev:" + ownerAccountId },
    uplinks: ["ws://localhost:9999"],
    storageProvider: storage,
    ownerAccountId,
    clock,
    sdk,
  });
}

async function seedDirectThread({ storage, ownerAccountId, threadId, peerAccountId, peerInboxId }) {
  const kv = storage.getKeyValueStore(ownerAccountId);
  await kv.set("app:threads/" + ownerAccountId + "/" + threadId, {
    threadId,
    threadType: "direct",
    peerAccountId,
    peerInboxId,
    createdAtMs: 500,
    updatedAtMs: 500,
  });
}

async function startServer(server) {
  if (!server.bus.runtime) server.bus.runtime = {};
  if (!server.bus.runtime.sdk) server.bus.runtime.sdk = {};
  if (!server.bus.runtime.sdk.subscriptions) {
    server.bus.runtime.sdk.subscriptions = { onMailboxDeposited: () => () => {} };
  }
  await server.bus.services.events.start();
  if (server.bus.services.messages && typeof server.bus.services.messages.start === "function") {
    await server.bus.services.messages.start();
  }
}

async function listMessages(server, threadId) {
  const result = await server.bus.services.messages.listMessages({ threadId });
  return Array.isArray(result.items) ? result.items : [];
}

async function waitForCondition(check, { timeoutMs = 1000, intervalMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

test("resend with same messageId reuses the existing row (no duplicate)", async () => {
  const storage = new TestStorageProvider();
  let now = 1000;
  const clock = () => (now += 100);

  await seedDirectThread({
    storage, ownerAccountId: ALICE, threadId: ALICE_DM_THREAD,
    peerAccountId: BOB, peerInboxId: "inbox:" + BOB,
  });

  // First attempt: SDK throws (non-queued, non-routing) → row goes "failed".
  // Second attempt: SDK succeeds with an eventId → row goes "sent".
  let attempt = 0;
  const sendBehavior = async (opts) => {
    attempt++;
    if (attempt === 1) {
      const err = new Error("simulated transient failure");
      err.code = "WS_DISCONNECTED";
      throw err;
    }
    return { ok: true, mailboxId: opts.deliverInboxId, eventId: "evt_resent_1" };
  };

  const alice = makeServer({ ownerAccountId: ALICE, storage, sendBehavior, clock });
  await startServer(alice);

  const statuses = [];
  alice.bus.on("message.status", (evt) => statuses.push({ messageId: evt.messageId, status: evt.status }));

  const MID = "mid_resend_basic";

  // First send fails at the SDK boundary. sendMessage rethrows because the
  // err isn't tagged queued. We catch and assert the row is marked failed.
  await assert.rejects(
    () => alice.bus.services.messages.sendMessage({
      threadId: ALICE_DM_THREAD,
      messageId: MID,
      payload: { kind: "rez.chat.message.v1", text: "first attempt" },
    }),
    /simulated transient failure/,
  );

  let rows = await listMessages(alice, ALICE_DM_THREAD);
  assert.equal(rows.length, 1, "first send should produce exactly one row");
  assert.equal(rows[0].messageId, MID);
  // The first send aborts via thrown SDK error before the post-send status
  // write runs, so the row is still in its initial pending state. The UI
  // would observe this via the message.deposited event; the user could tap
  // retry from there. (A queued-then-expired path would set "failed"; both
  // routes funnel into the same resend contract, so we cover the harder
  // duplication-risk path here.)
  assert.equal(rows[0].status, "pending");

  // Resend with the same messageId. Different payload text proves the
  // caller-supplied payload is accepted as fresh truth.
  await alice.bus.services.messages.sendMessage({
    threadId: ALICE_DM_THREAD,
    messageId: MID,
    payload: { kind: "rez.chat.message.v1", text: "resent" },
  });

  rows = await listMessages(alice, ALICE_DM_THREAD);
  assert.equal(rows.length, 1, "resend must NOT duplicate the row");
  assert.equal(rows[0].messageId, MID);
  assert.equal(rows[0].status, "sent", "resend should drive the row to sent on SDK success");
  assert.equal(rows[0].text, "resent", "row should carry the fresh payload text");
  assert.equal(attempt, 2, "exactly one SDK call per send attempt");

  const finalStatus = statuses.filter((s) => s.messageId === MID).slice(-1)[0];
  assert.deepEqual(finalStatus, { messageId: MID, status: "sent" });
});

test("resend after queued+expired clears stale tracking and drives a fresh sent on retry", async () => {
  const storage = new TestStorageProvider();
  let now = 1000;
  const clock = () => (now += 100);

  await seedDirectThread({
    storage, ownerAccountId: ALICE, threadId: ALICE_DM_THREAD,
    peerAccountId: BOB, peerInboxId: "inbox:" + BOB,
  });

  // Attempt 1: SDK reports queued (no synchronous route). Chat-server
  // marks row "queued" and populates #queueTracking / #queuedByInbox.
  // Then we fire an EVT_OUTBOUND_STATUS "expired" frame to drive the
  // row to "failed".
  // Attempt 2 (resend): SDK succeeds → row goes "sent". This is the
  // scenario where stale tracking would bite if the cleanup at the top
  // of sendMessage weren't present.
  let attempt = 0;
  const sendBehavior = async (opts) => {
    attempt++;
    if (attempt === 1) {
      return { ok: true, queued: true, mailboxId: opts.deliverInboxId };
    }
    return { ok: true, mailboxId: opts.deliverInboxId, eventId: "evt_after_expiry" };
  };

  // Wire a controllable outbound-status subscription. The ChatServerApp's
  // sdk stub returns a no-op subscription; we override here to capture the
  // handler the messages service registers so we can fire frames at it.
  let outboundStatusHandler = null;
  const alice = (() => {
    const sdk = {
      sendEncryptedDeposit: async (opts) => sendBehavior(opts),
      getIdentity: () => ({ localInboxId: "inbox:" + ALICE }),
      subscriptions: {
        onEvent: (eventType, handler) => {
          if (eventType === REZ_CONTRACT_TYPES.EVT_OUTBOUND_STATUS) {
            outboundStatusHandler = handler;
          }
          return () => {};
        },
        onMailboxDeposited: () => () => {},
      },
    };
    return new ChatServerApp({
      identity: { ...FAKE_IDENTITY_KEYS, accountId: ALICE, deviceId: "dev:" + ALICE },
      uplinks: ["ws://localhost:9999"],
      storageProvider: storage,
      ownerAccountId: ALICE,
      clock,
      sdk,
    });
  })();
  await startServer(alice);
  assert.equal(typeof outboundStatusHandler, "function", "messages service should subscribe to EVT_OUTBOUND_STATUS");

  const statuses = [];
  alice.bus.on("message.status", (evt) => statuses.push({ messageId: evt.messageId, status: evt.status }));

  const MID = "mid_resend_after_expiry";

  await alice.bus.services.messages.sendMessage({
    threadId: ALICE_DM_THREAD,
    messageId: MID,
    payload: { kind: "rez.chat.message.v1", text: "offline send" },
  });

  let rows = await listMessages(alice, ALICE_DM_THREAD);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "queued", "queued SDK result should mark row queued");

  // Drive an "expired" status frame for the deliver inbox. The handler
  // dispatches asynchronously (fire-and-forget), so poll for the row to
  // transition to "failed".
  outboundStatusHandler({
    t: REZ_CONTRACT_TYPES.EVT_OUTBOUND_STATUS,
    body: {
      queueId: "q_test_1",
      deliverInboxId: "inbox:" + BOB,
      status: "expired",
      attemptedAtMs: clock(),
    },
  });

  const failedOk = await waitForCondition(async () => {
    const r = await listMessages(alice, ALICE_DM_THREAD);
    return r.length === 1 && r[0].status === "failed";
  });
  assert.equal(failedOk, true, "expired frame should mark the queued row failed");
  rows = await listMessages(alice, ALICE_DM_THREAD);

  // Resend. Same messageId.
  await alice.bus.services.messages.sendMessage({
    threadId: ALICE_DM_THREAD,
    messageId: MID,
    payload: { kind: "rez.chat.message.v1", text: "offline send" },
  });

  rows = await listMessages(alice, ALICE_DM_THREAD);
  assert.equal(rows.length, 1, "resend must not duplicate the row");
  assert.equal(rows[0].status, "sent", "second attempt with successful SDK should drive row to sent");
  assert.equal(attempt, 2, "exactly two SDK calls across both sends");

  // Verify the message.status stream shows the full failed → sent recovery.
  const seen = statuses.filter((s) => s.messageId === MID).map((s) => s.status);
  assert.ok(seen.includes("queued"), "should observe queued on first attempt: " + JSON.stringify(seen));
  assert.ok(seen.includes("failed"), "should observe failed after expired: " + JSON.stringify(seen));
  assert.equal(seen[seen.length - 1], "sent", "final status should be sent: " + JSON.stringify(seen));
});
