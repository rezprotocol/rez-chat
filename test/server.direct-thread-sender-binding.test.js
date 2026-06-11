// REZ-3 regression: direct-thread sender binding. An inbound message that resolves
// an EXISTING direct (1:1) thread via its threadId must come from that thread's
// peer. The threadId is attacker-supplied; the direct-content gate (isActiveContact)
// only runs when the thread has to be resolved FROM the sender, so supplying a
// known direct threadId bypassed it. Without the binding check a group co-member
// who can deliver an authenticated payload could pass any direct threadId and have
// their message attributed to — and edit/tombstone/react AS — the thread's real
// peer. ServerEventService now drops a direct message whose thread peer != the
// cryptographically-authenticated envelope sender.

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
const MALLORY = "rez:acct:mallory";
const DIRECT_THREAD_ID = "th_alice_bob_direct";

async function setupServer() {
  const app = new ChatServerApp({
    identity: { ...FAKE_KEYS, accountId: OWNER, deviceId: "dev:alice" },
    uplinks: ["ws://localhost:9999"],
    storageProvider: new TestStorageProvider(),
    ownerAccountId: OWNER,
    clock: () => Date.now(),
  });
  // Alice <-> Bob direct thread (the target the attacker will try to inject into).
  await app.bus.services.threads.ensureDirectThread({
    threadId: DIRECT_THREAD_ID, peerAccountId: BOB, peerInboxId: "inbox:bob", createdAtMs: 1000,
  });
  await app.bus.services.events.start();
  return app;
}

async function deliver(app, { authenticatedSender, threadId, messageId, text }) {
  const body = { kind: MESSAGE_KIND, threadId, senderAccountId: authenticatedSender, text };
  if (messageId !== undefined) body.messageId = messageId;
  const plaintextB64 = Buffer.from(JSON.stringify(body)).toString("base64");
  await app.bus.services.events.applyUserMessage({
    eventId: "evt_" + messageId, mailboxId: "inbox:alice", senderAccountId: authenticatedSender, plaintextB64,
  });
}

async function listMessages(app, threadId) {
  const page = await app.bus.stores.threadStore.listMessages({ threadId, limit: 50 });
  return page && Array.isArray(page.items) ? page.items : [];
}

test("REZ-3: a co-member cannot inject into another peer's direct thread via a forged threadId", async () => {
  const app = await setupServer();
  // Mallory (authenticated as herself) supplies Alice<->Bob's direct threadId.
  await deliver(app, { authenticatedSender: MALLORY, threadId: DIRECT_THREAD_ID, messageId: "spoof", text: "I am bob" });
  const rows = await listMessages(app, DIRECT_THREAD_ID);
  assert.equal(rows.length, 0, "the spoofed message must NOT land in Alice<->Bob's direct thread");
});

test("REZ-3: the thread's real peer can still deliver into the direct thread", async () => {
  const app = await setupServer();
  await deliver(app, { authenticatedSender: BOB, threadId: DIRECT_THREAD_ID, messageId: "real", text: "hi alice" });
  const rows = await listMessages(app, DIRECT_THREAD_ID);
  const row = rows.find((m) => m.messageId === "real");
  assert.ok(row, "the real peer's message is persisted");
  assert.equal(row.senderAccountId, BOB, "attributed to the authenticated peer");
});
