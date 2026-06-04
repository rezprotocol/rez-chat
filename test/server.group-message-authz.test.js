// SECURITY (audit pass 5, H1): inbound group CONTENT must be authorized
// against the sender's *active* membership, and the persisted sender identity
// must be the cryptographically-authenticated peer — never the payload's
// self-declared sender.
//
// These drive the real ServerEventService inbound path the way the live system
// does: a decrypted E2EE deposit surfaces as a `peerlink.user.message` bus
// event whose `senderAccountId` is the authenticated peer (from the ratchet
// snapshot). The payload body is plaintext JSON the sender authored.

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
const BOB = "rez:acct:bob";          // active member
const MALLORY = "rez:acct:mallory";  // never a member
const GROUP_ID = "grp_authz";

function flush() { return new Promise((r) => setTimeout(r, 0)); }

async function setupServer() {
  const app = new ChatServerApp({
    identity: { ...FAKE_KEYS, accountId: OWNER, deviceId: "dev:alice" },
    uplinks: ["ws://localhost:9999"],
    storageProvider: new TestStorageProvider(),
    ownerAccountId: OWNER,
    clock: () => Date.now(),
  });
  // Group exists; Bob is an active member, Mallory is not.
  await app.bus.services.threads.ensureGroupThread({
    groupId: GROUP_ID, title: "Authz", createdAtMs: 1000,
  });
  await app.bus.stores.groupStore.ensureMembership({
    ownerAccountId: OWNER, groupId: GROUP_ID, accountId: OWNER, role: "admin",
  });
  await app.bus.stores.groupStore.ensureMembership({
    ownerAccountId: OWNER, groupId: GROUP_ID, accountId: BOB, role: "member",
  });
  await app.bus.services.events.start();
  return app;
}

// Deliver a group message as the live system does: `authedSender` is the
// authenticated peer; `claimedSender` is whatever the sender wrote into the
// encrypted body (possibly a lie).
async function deliverGroupMessage(app, { authedSender, claimedSender, messageId, text }) {
  const threadId = app.bus.services.threads.groupThreadId(GROUP_ID);
  const body = {
    kind: MESSAGE_KIND,
    threadId,
    messageId,
    senderAccountId: claimedSender,
    text,
  };
  const plaintextB64 = Buffer.from(JSON.stringify(body)).toString("base64");
  // Drive the canonical apply directive directly — this is exactly what the
  // serialized InboundDepositPipeline calls after ServerPeerLinkProtocolService
  // decrypts an E2EE deposit (no longer a fire-and-forget bus event).
  await app.bus.services.events.applyUserMessage({
    eventId: "evt_" + messageId,
    mailboxId: "inbox:alice",
    senderAccountId: authedSender,
    plaintextB64,
  });
  return threadId;
}

async function listGroupMessages(app, threadId) {
  const page = await app.bus.stores.threadStore.listMessages({ threadId, limit: 50 });
  return page && Array.isArray(page.items) ? page.items : [];
}

test("H1: a group message from an ACTIVE member is persisted with the authenticated sender", async () => {
  const app = await setupServer();
  const threadId = await deliverGroupMessage(app, {
    authedSender: BOB, claimedSender: BOB, messageId: "m_ok", text: "hello group",
  });
  const items = await listGroupMessages(app, threadId);
  const msg = items.find((m) => m.messageId === "m_ok");
  assert.ok(msg, "active member's message is persisted");
  assert.equal(msg.senderAccountId, BOB);
});

test("H1: a group message from a NON-member is dropped and does NOT create membership", async () => {
  const app = await setupServer();
  const threadId = await deliverGroupMessage(app, {
    authedSender: MALLORY, claimedSender: MALLORY, messageId: "m_evil", text: "i'm not in this group",
  });
  const items = await listGroupMessages(app, threadId);
  assert.equal(items.find((m) => m.messageId === "m_evil"), undefined,
    "non-member's group message is dropped (not persisted/rendered)");
  // And crucially: receiving the message must NOT phantom-add Mallory.
  const membership = await app.bus.stores.groupStore.getMembership({
    ownerAccountId: OWNER, groupId: GROUP_ID, accountId: MALLORY,
  });
  assert.ok(!membership, "no phantom membership created from a message");
});

test("H1: a KICKED member can no longer inject group messages (peer-link survives the kick)", async () => {
  const app = await setupServer();
  // Bob is kicked: membership → removed (peer-link/session still exists).
  await app.bus.stores.groupStore.removeMember({
    ownerAccountId: OWNER, groupId: GROUP_ID, accountId: BOB,
  });
  const threadId = await deliverGroupMessage(app, {
    authedSender: BOB, claimedSender: BOB, messageId: "m_afterkick", text: "i'm baaack",
  });
  const items = await listGroupMessages(app, threadId);
  assert.equal(items.find((m) => m.messageId === "m_afterkick"), undefined,
    "a removed member's group message is dropped");
  const membership = await app.bus.stores.groupStore.getMembership({
    ownerAccountId: OWNER, groupId: GROUP_ID, accountId: BOB,
  });
  assert.equal(membership.state, "removed", "the kicked member is NOT revived by sending a message");
});

test("H1: sender SPOOFING is defeated — payload-claimed sender is ignored for groups", async () => {
  const app = await setupServer();
  // Authenticated as Bob (a member), but the encrypted body LIES that it came
  // from Alice (the admin). The persisted sender must be the authenticated Bob.
  const threadId = await deliverGroupMessage(app, {
    authedSender: BOB, claimedSender: OWNER, messageId: "m_spoof", text: "this is totally alice",
  });
  const items = await listGroupMessages(app, threadId);
  const msg = items.find((m) => m.messageId === "m_spoof");
  assert.ok(msg, "the message (from a real member) is accepted");
  assert.equal(msg.senderAccountId, BOB,
    "persisted sender is the authenticated peer, NOT the spoofed payload sender");
  assert.notEqual(msg.senderAccountId, OWNER, "spoof did not stick");
});
