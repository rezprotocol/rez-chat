// Race B (2026-06-07): a decrypted group message whose authenticated sender's
// member.join hasn't been processed YET (the message was push-delivered ahead of
// the join — the offline-accept ordering race) must be DEFERRED, not dropped,
// and re-applied when the join activates the sender. Security is preserved:
// delivery still requires active membership, only deferred; a kicked ("removed")
// member is still dropped (never resurrected). See
// project_offline_push_before_handshake_race.

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
const GROUP_ID = "grp_defer";

async function setupServer() {
  const app = new ChatServerApp({
    identity: { ...FAKE_KEYS, accountId: OWNER, deviceId: "dev:alice" },
    uplinks: ["ws://localhost:9999"],
    storageProvider: new TestStorageProvider(),
    ownerAccountId: OWNER,
    clock: () => Date.now(),
  });
  await app.bus.services.threads.ensureGroupThread({ groupId: GROUP_ID, title: "Defer", createdAtMs: 1000 });
  await app.bus.stores.groupStore.ensureMembership({ ownerAccountId: OWNER, groupId: GROUP_ID, accountId: OWNER, role: "admin" });
  await app.bus.services.events.start();
  return app;
}

async function deliverGroupMessage(app, { authedSender, messageId, text }) {
  const threadId = app.bus.services.threads.groupThreadId(GROUP_ID);
  const body = { kind: MESSAGE_KIND, threadId, messageId, senderAccountId: authedSender, text };
  const plaintextB64 = Buffer.from(JSON.stringify(body)).toString("base64");
  await app.bus.services.events.applyUserMessage({
    eventId: "evt_" + messageId, mailboxId: "inbox:alice", senderAccountId: authedSender, plaintextB64,
  });
  return threadId;
}

async function listGroupMessages(app, threadId) {
  const page = await app.bus.stores.threadStore.listMessages({ threadId, limit: 50 });
  return page && Array.isArray(page.items) ? page.items : [];
}

test("a group message that arrives before the sender's join is DEFERRED, then delivered after flush", async () => {
  const app = await setupServer();
  // Bob has NO membership record yet (his member.join hasn't been processed).
  const threadId = await deliverGroupMessage(app, { authedSender: BOB, messageId: "m_early", text: "ahead of my join" });

  // Deferred — not persisted yet, and crucially NOT phantom-added as a member.
  assert.equal((await listGroupMessages(app, threadId)).find((m) => m.messageId === "m_early"), undefined,
    "message held, not persisted before the join");
  assert.ok(!(await app.bus.stores.groupStore.getMembership({ ownerAccountId: OWNER, groupId: GROUP_ID, accountId: BOB })),
    "deferral does NOT create phantom membership");

  // Bob's join lands: he becomes active, and the flush re-applies his message.
  await app.bus.stores.groupStore.ensureMembership({ ownerAccountId: OWNER, groupId: GROUP_ID, accountId: BOB, role: "member" });
  await app.bus.services.events.flushDeferredGroupMessages(GROUP_ID, BOB);

  const msg = (await listGroupMessages(app, threadId)).find((m) => m.messageId === "m_early");
  assert.ok(msg, "the deferred message is delivered once the sender is active");
  assert.equal(msg.senderAccountId, BOB, "persisted with the authenticated sender");
});

test("a deferred message is NOT delivered while the sender never becomes active (security preserved)", async () => {
  const app = await setupServer();
  const threadId = await deliverGroupMessage(app, { authedSender: MALLORY, messageId: "m_never", text: "let me in" });
  // No join for Mallory. Flushing her key is a no-op (she's still not active);
  // even if flushed, the gate re-check would drop her (no membership).
  await app.bus.services.events.flushDeferredGroupMessages(GROUP_ID, MALLORY);
  assert.equal((await listGroupMessages(app, threadId)).find((m) => m.messageId === "m_never"), undefined,
    "a sender who never joins is never delivered");
});

test("a kicked (removed) member's message is dropped, not deferred (no resurrection on re-admit)", async () => {
  const app = await setupServer();
  await app.bus.stores.groupStore.ensureMembership({ ownerAccountId: OWNER, groupId: GROUP_ID, accountId: BOB, role: "member" });
  await app.bus.stores.groupStore.removeMember({ ownerAccountId: OWNER, groupId: GROUP_ID, accountId: BOB });

  const threadId = await deliverGroupMessage(app, { authedSender: BOB, messageId: "m_kicked", text: "i'm back" });
  // Dropped (membership exists but is "removed" → not a pending joiner).
  assert.equal((await listGroupMessages(app, threadId)).find((m) => m.messageId === "m_kicked"), undefined,
    "kicked member's message is dropped");

  // Re-admit Bob and flush — the kicked-era message must NOT resurface.
  await app.bus.stores.groupStore.ensureMembership({ ownerAccountId: OWNER, groupId: GROUP_ID, accountId: BOB, role: "member" });
  await app.bus.services.events.flushDeferredGroupMessages(GROUP_ID, BOB);
  assert.equal((await listGroupMessages(app, threadId)).find((m) => m.messageId === "m_kicked"), undefined,
    "re-admission does not resurrect a message sent while removed");
});
