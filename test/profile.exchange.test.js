import test from "node:test";
import assert from "node:assert/strict";
import { ServerProfileService } from "../src/server/services/ServerProfileService.js";
import { CHAT_BRIDGE_SPEC } from "../src/server/transport/ChatBridge.js";
import { ProfileBroadcastParams, ProfileBroadcastResult } from "../src/records/index.js";
import { ProfilePayloadV1 } from "@rezprotocol/sdk/profile";
import { makeSealDispatch } from "./support/sealDispatchDouble.js";

function createBus() {
  const fns = {};
  const events = {};
  return {
    services: {},
    stores: {},
    runtime: {},
    registerFunction({ namespace, name, fn }) {
      fns[namespace + "." + name] = fn;
    },
    call(namespace, name, payload) {
      const fn = fns[namespace + "." + name];
      if (!fn) throw new Error("No registered function: " + namespace + "." + name);
      return fn(payload);
    },
    on(eventName, handler) {
      if (!events[eventName]) events[eventName] = [];
      events[eventName].push(handler);
      return () => {
        const arr = events[eventName];
        const idx = arr.indexOf(handler);
        if (idx >= 0) arr.splice(idx, 1);
      };
    },
    emit(eventName, payload) {
      const handlers = events[eventName] || [];
      for (const h of handlers) h(payload);
    },
    _fns: fns,
    _events: events,
  };
}

function createContactStore() {
  const contacts = {};
  return {
    async get({ ownerAccountId, accountId }) {
      return contacts[ownerAccountId + "/" + accountId] || null;
    },
    async upsert({ ownerAccountId, accountId, patch }) {
      const key = ownerAccountId + "/" + accountId;
      const existing = contacts[key] || { accountId: ownerAccountId, accountId };
      const next = { ...existing, ...patch, updatedAtMs: Date.now() };
      contacts[key] = next;
      return { contact: next, created: !existing.displayName };
    },
    _contacts: contacts,
  };
}

function createThreadStore(threads) {
  return {
    async listThreadIds() {
      return Object.keys(threads);
    },
    async getThread(id) {
      return threads[id] || null;
    },
  };
}

function createService({ threads = {}, ownerDisplayName = null, clock = () => 1000 } = {}) {
  const bus = createBus();
  const contactStore = createContactStore();
  const threadStore = createThreadStore(threads);
  const deposits = [];
  const logger = { error() {}, warn() {} };

  bus.runtime.sdk = {
    ...makeSealDispatch({ onSend: (opts) => { deposits.push(opts); } }),
    getIdentity: () => ({ localInboxId: "inbox_owner" }),
  };

  const service = new ServerProfileService({
    bus,
    contactStore,
    threadStore,
    ownerAccountId: "owner_123",
    ownerDisplayName,
    clock,
    logger,
  });

  return { bus, contactStore, threadStore, deposits, service, logger };
}

test("handleIncomingProfile updates contact displayName", async () => {
  const { service, contactStore } = createService();
  // A profile only UPDATES an existing contact — it never creates one (see the no-create test
  // below), so the contact this test means to update has to exist first.
  contactStore._contacts["owner_123/peer_abc"] = {
    ownerAccountId: "owner_123",
    accountId: "peer_abc",
    displayName: "old",
    updatedAtMs: 1000,
  };
  const consumed = await service.handleIncomingProfile(
    new ProfilePayloadV1({ displayName: "Alice", updatedAtMs: 5000, avatarFileHash: "" }),
    { senderAccountId: "peer_abc" },
  );
  assert.equal(consumed, true);
  const contact = await contactStore.get({ ownerAccountId: "owner_123", accountId: "peer_abc" });
  assert.equal(contact.displayName, "Alice");
});

test("handleIncomingProfile rejects stale profile (older updatedAtMs)", async () => {
  const { service, contactStore } = createService();
  contactStore._contacts["owner_123/peer_abc"] = {
    ownerAccountId: "owner_123",
    accountId: "peer_abc",
    displayName: "Bob",
    updatedAtMs: 9000,
  };
  const consumed = await service.handleIncomingProfile(
    new ProfilePayloadV1({ displayName: "BobOld", updatedAtMs: 5000, avatarFileHash: "" }),
    { senderAccountId: "peer_abc" },
  );
  assert.equal(consumed, true);
  const contact = await contactStore.get({ ownerAccountId: "owner_123", accountId: "peer_abc" });
  assert.equal(contact.displayName, "Bob");
});

test("handleIncomingProfile accepts newer profile", async () => {
  const { service, contactStore } = createService();
  contactStore._contacts["owner_123/peer_abc"] = {
    ownerAccountId: "owner_123",
    accountId: "peer_abc",
    displayName: "Bob",
    updatedAtMs: 5000,
  };
  const consumed = await service.handleIncomingProfile(
    new ProfilePayloadV1({ displayName: "Robert", updatedAtMs: 9000, avatarFileHash: "" }),
    { senderAccountId: "peer_abc" },
  );
  assert.equal(consumed, true);
  const contact = await contactStore.get({ ownerAccountId: "owner_123", accountId: "peer_abc" });
  assert.equal(contact.displayName, "Robert");
});

test("handleIncomingProfile emits contacts.updated", async () => {
  const { service, bus, contactStore } = createService();
  contactStore._contacts["owner_123/peer_xyz"] = {
    ownerAccountId: "owner_123",
    accountId: "peer_xyz",
    displayName: "old",
    updatedAtMs: 1000,
  };
  let emitted = null;
  // The event is `contact.updated` (singular) carrying a ContactUpdatedEvent that WRAPS the
  // contact — this test predated both the rename and the wrapper, and asserted the fields
  // directly on the payload.
  bus.on("contact.updated", (payload) => { emitted = payload; });
  await service.handleIncomingProfile(
    new ProfilePayloadV1({ displayName: "Carol", updatedAtMs: 5000, avatarFileHash: "" }),
    { senderAccountId: "peer_xyz" },
  );
  assert.ok(emitted, "contact.updated should have been emitted");
  assert.equal(emitted.contact.displayName, "Carol");
  assert.equal(emitted.contact.accountId, "peer_xyz");
});

test("handleIncomingProfile rejects invalid payload", async () => {
  const { service } = createService();
  assert.equal(await service.handleIncomingProfile(null, { senderAccountId: "peer_abc" }), false);
  assert.equal(await service.handleIncomingProfile({ kind: "other" }, { senderAccountId: "peer_abc" }), false);
  assert.equal(await service.handleIncomingProfile(
    { kind: "rez.profile.v1", displayName: "", updatedAtMs: 5000 },
    { senderAccountId: "peer_abc" },
  ), false);
  assert.equal(await service.handleIncomingProfile(
    { kind: "rez.profile.v1", displayName: "Alice", updatedAtMs: -1 },
    { senderAccountId: "peer_abc" },
  ), false);
  assert.equal(await service.handleIncomingProfile(
    new ProfilePayloadV1({ displayName: "Alice", updatedAtMs: 5000, avatarFileHash: "" }),
    { senderAccountId: "" },
  ), false);
});

test("broadcastUpdate sends to all active direct peers", async () => {
  const threads = {
    "th_1": { peerAccountId: "peer_a", peerInboxId: "inbox_a" },
    "th_2": { peerAccountId: "peer_b", peerInboxId: "inbox_b" },
    "th_3": { peerAccountId: "", peerInboxId: "" },
    "th_4": { peerAccountId: "owner_123", peerInboxId: "inbox_self" },
  };
  const { service, deposits } = createService({ threads });

  const result = await service.broadcastUpdate({ displayName: "NewName" });
  assert.equal(result.sent, 2);
  assert.equal(result.failed, 0);
  assert.equal(deposits.length, 2);

  const peerIds = deposits.map((d) => d.peerAccountId).sort();
  assert.deepEqual(peerIds, ["peer_a", "peer_b"]);

  for (const dep of deposits) {
    const text = new TextDecoder().decode(dep.plaintextBodyBytes);
    const parsed = JSON.parse(text);
    assert.equal(parsed.kind, "rez.profile.v1");
    assert.equal(parsed.displayName, "NewName");
  }
});

test("broadcastUpdate skips threads without peerInboxId", async () => {
  const threads = {
    "th_1": { peerAccountId: "peer_a", peerInboxId: "" },
  };
  const { service, deposits } = createService({ threads });
  const result = await service.broadcastUpdate({ displayName: "Test" });
  assert.equal(result.sent, 0);
  assert.equal(deposits.length, 0);
});

test("sendProfileToPeer sends profile when ownerDisplayName is set", async () => {
  const threads = {
    "th_1": { peerAccountId: "peer_a", peerInboxId: "inbox_a" },
  };
  const { service, deposits } = createService({ threads, ownerDisplayName: "MyName" });

  await service.sendProfileToPeer({
    peerAccountId: "peer_a",
    threadId: "th_1",
    peerInboxId: "inbox_a",
  });

  assert.equal(deposits.length, 1);
  const text = new TextDecoder().decode(deposits[0].plaintextBodyBytes);
  const parsed = JSON.parse(text);
  assert.equal(parsed.kind, "rez.profile.v1");
  assert.equal(parsed.displayName, "MyName");
});

test("sendProfileToPeer skips when no ownerDisplayName", async () => {
  const threads = {
    "th_1": { peerAccountId: "peer_a", peerInboxId: "inbox_a" },
  };
  const { service, deposits } = createService({ threads });

  await service.sendProfileToPeer({
    peerAccountId: "peer_a",
    threadId: "th_1",
    peerInboxId: "inbox_a",
  });

  assert.equal(deposits.length, 0);
});

test("broadcastUpdate stores displayName for subsequent sendProfileToPeer", async () => {
  const threads = {
    "th_1": { peerAccountId: "peer_a", peerInboxId: "inbox_a" },
  };
  const { service, deposits } = createService({ threads });

  await service.broadcastUpdate({ displayName: "Updated" });
  deposits.length = 0;

  await service.sendProfileToPeer({
    peerAccountId: "peer_b",
    threadId: "th_1",
    peerInboxId: "inbox_b",
  });

  assert.equal(deposits.length, 1);
  const text = new TextDecoder().decode(deposits[0].plaintextBodyBytes);
  const parsed = JSON.parse(text);
  assert.equal(parsed.displayName, "Updated");
});

test("CHAT_BRIDGE_SPEC includes profile.broadcast method", () => {
  const entry = CHAT_BRIDGE_SPEC.methods["profile.broadcast"];
  assert.ok(entry, "profile.broadcast should be in methods");
  assert.equal(entry.params, ProfileBroadcastParams);
  assert.equal(entry.result, ProfileBroadcastResult);
});

test("ProfileBroadcastParams round-trip via toJSON/fromJSON", () => {
  const params = new ProfileBroadcastParams({ displayName: "Alice" });
  const json = params.toJSON();
  const restored = ProfileBroadcastParams.fromJSON(json);
  assert.equal(restored.displayName, "Alice");
});

test("ProfileBroadcastResult round-trip via toJSON/fromJSON", () => {
  const result = new ProfileBroadcastResult({ sent: 3, failed: 1 });
  const json = result.toJSON();
  const restored = ProfileBroadcastResult.fromJSON(json);
  assert.equal(restored.sent, 3);
  assert.equal(restored.failed, 1);
});

test("handleIncomingProfile ACKS but does not CREATE a contact for an unknown peer", async () => {
  // Contacts come solely from an explicit 1:1 flow (direct invite / connect-request approval).
  // A profile from a peer we hold no contact for — a group co-member sharing a fan-out peer-link,
  // say — must not mint one, or group membership would leak into the contact list. It is still
  // acknowledged (consumed: true); there is simply nothing to store.
  const { service, contactStore, bus } = createService();
  let emitted = null;
  bus.on("contact.updated", (payload) => { emitted = payload; });

  const consumed = await service.handleIncomingProfile(
    new ProfilePayloadV1({ displayName: "Stranger", updatedAtMs: 5000, avatarFileHash: "" }),
    { senderAccountId: "peer_unknown" },
  );

  assert.equal(consumed, true, "acknowledged, so the sender does not retry forever");
  assert.equal(await contactStore.get({ ownerAccountId: "owner_123", accountId: "peer_unknown" }), null);
  assert.equal(emitted, null, "no contact, no contact.updated");
});
