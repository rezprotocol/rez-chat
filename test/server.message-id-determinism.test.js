// Determinism guard (FLOW_AUDIT 2026-06-07, finding #10): double-delivery across
// the three recovery buffers — InboundDepositPipeline self-heal (Race A),
// ServerEventService defer-and-flush (Race B), and push-vs-catch-up — is
// prevented ONLY by idempotent persistence keyed on the message's CONTENT id.
// ServerEventService computes `canonicalMessageId = payload.messageId || eventId`
// (ServerEventService.js). The load-bearing invariant: the SAME logical message,
// re-presented with a DIFFERENT delivery framing (a fresh eventId from a later
// catch-up or a defer-flush re-apply), must collapse to ONE persisted row because
// it shares payload.messageId. If that key ever drifted to a per-delivery value
// (eventId, attempt count, clock), the same message would persist twice. These
// tests pin the invariant and its eventId-fallback boundary.

import test from "node:test";
import assert from "node:assert/strict";

import { ChatServerApp } from "../src/server/app/ChatServerApp.js";
import { MESSAGE_KIND } from "../src/records/payloads/ChatMessagePayloadV1.js";

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
}

const FAKE_KEYS = {
  publicKeyB64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  privateKeyB64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
};

const OWNER = "rez:acct:alice";
const BOB = "rez:acct:bob";
const GROUP_ID = "grp_msgid";

async function setupServer() {
  const app = new ChatServerApp({
    identity: { ...FAKE_KEYS, accountId: OWNER, deviceId: "dev:alice" },
    uplinks: ["ws://localhost:9999"],
    storageProvider: new TestStorageProvider(),
    ownerAccountId: OWNER,
    clock: () => Date.now(),
  });
  await app.bus.services.threads.ensureGroupThread({ groupId: GROUP_ID, title: "MsgId", createdAtMs: 1000 });
  await app.bus.stores.groupStore.ensureMembership({ ownerAccountId: OWNER, groupId: GROUP_ID, accountId: OWNER, role: "admin" });
  // Bob is an active member so the fail-closed group authz gate passes and we
  // exercise the persistence path (not the defer path).
  await app.bus.stores.groupStore.ensureMembership({ ownerAccountId: OWNER, groupId: GROUP_ID, accountId: BOB, role: "member" });
  await app.bus.services.events.start();
  return app;
}

// Deliver a decrypted group message with explicitly-chosen eventId and messageId
// so a test can vary the delivery framing (eventId) independently of content id.
async function deliver(app, { eventId, messageId, text }) {
  const threadId = app.bus.services.threads.groupThreadId(GROUP_ID);
  const body = { kind: MESSAGE_KIND, threadId, senderAccountId: BOB, text };
  if (messageId !== undefined) body.messageId = messageId;
  const plaintextB64 = Buffer.from(JSON.stringify(body)).toString("base64");
  await app.bus.services.events.applyUserMessage({
    eventId, mailboxId: "inbox:alice", senderAccountId: BOB, plaintextB64,
  });
  return threadId;
}

async function listGroupMessages(app, threadId) {
  const page = await app.bus.stores.threadStore.listMessages({ threadId, limit: 50 });
  return page && Array.isArray(page.items) ? page.items : [];
}

test("same payload.messageId across different delivery framings collapses to one persisted row", async () => {
  const app = await setupServer();
  // Push delivers the message first under one eventId...
  const threadId = await deliver(app, { eventId: "evt_push_1", messageId: "m1", text: "hello" });
  // ...then a later catch-up (or defer-flush re-apply) re-presents the SAME
  // logical message under a DIFFERENT eventId. Idempotent persistence on
  // payload.messageId must keep it to one row.
  await deliver(app, { eventId: "evt_catchup_2", messageId: "m1", text: "hello" });

  const rows = (await listGroupMessages(app, threadId)).filter((m) => m.messageId === "m1");
  assert.equal(rows.length, 1,
    "two deliveries of the same payload.messageId (distinct eventIds) persist exactly once");
});

test("canonical id is payload.messageId, NOT the per-delivery eventId", async () => {
  const app = await setupServer();
  const threadId = await deliver(app, { eventId: "evt_unrelated_framing", messageId: "m_canon", text: "x" });
  const rows = await listGroupMessages(app, threadId);
  const row = rows.find((m) => m.messageId === "m_canon");
  assert.ok(row, "message is persisted under its payload messageId");
  assert.ok(!rows.some((m) => m.messageId === "evt_unrelated_framing"),
    "the eventId is never used as the stored id when the payload carries a messageId");
});
