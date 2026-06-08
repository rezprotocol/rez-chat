import test from "node:test";
import assert from "node:assert/strict";

import { ChatServerApp } from "../src/server/app/ChatServerApp.js";
import { GroupStore } from "../src/server/storage/ChatGroupStore.js";
import { GroupOpPayloadV1, groupOpPayloadToBytes } from "../src/records/payloads/GroupOpPayloadV1.js";
import { makeSealDispatch } from "./support/sealDispatchDouble.js";

/**
 * member.contact op coverage: peer-routing propagation that lets a transitively
 * invited member learn pre-existing members (add-only, anti-resurrection safe)
 * and fire a peer-link introduction toward each. See
 * project_group_peerlinks_invite_tree_not_mesh.
 */

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

const OWNER = "rez:acct:test-owner";
const SENDER = "rez:acct:sender-hub";
const NEWBIE = "rez:acct:newbie";
const GROUP_ID = "grp_contact_test";

const FAKE_IDENTITY = {
  accountId: OWNER,
  publicKeyB64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  privateKeyB64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
};

function createServer(storage) {
  return new ChatServerApp({
    identity: FAKE_IDENTITY,
    uplinks: ["ws://localhost:9999"],
    storageProvider: storage,
    ownerAccountId: OWNER,
    clock: () => 2000,
    sdk: {
      ...makeSealDispatch(),
      getIdentity: () => ({ localInboxId: "inbox:test-owner" }),
    },
  });
}

async function seedGroup(storage, { newbieState } = {}) {
  const groupStore = new GroupStore({ storageProvider: storage, clock: () => 1000 });
  await groupStore.ensureGroup({ ownerAccountId: OWNER, groupId: GROUP_ID, createdBy: OWNER, title: "Contact Test" });
  await groupStore.ensureMembership({ ownerAccountId: OWNER, groupId: GROUP_ID, accountId: OWNER, role: "creator" });
  // SENDER is an active member — required for the op's sender-must-be-member gate.
  await groupStore.ensureMembership({ ownerAccountId: OWNER, groupId: GROUP_ID, accountId: SENDER, role: "member" });
  if (newbieState === "removed") {
    await groupStore.ensureMembership({ ownerAccountId: OWNER, groupId: GROUP_ID, accountId: NEWBIE, role: "member" });
    await groupStore.removeMember({ ownerAccountId: OWNER, groupId: GROUP_ID, accountId: NEWBIE });
  }
  return groupStore;
}

function contactOp(contacts) {
  return new GroupOpPayloadV1({
    op: "member.contact",
    groupId: GROUP_ID,
    contacts,
    actedAtMs: 2000,
    groupOpId: "gop_contact_1",
  });
}

test("member.contact op round-trips its contacts through wire bytes", () => {
  const op = contactOp([{ accountId: NEWBIE, inboxId: "inbox:newbie", displayName: "Newbie" }]);
  const bytes = groupOpPayloadToBytes(op);
  const decoded = new GroupOpPayloadV1(JSON.parse(new TextDecoder().decode(bytes)));
  assert.equal(decoded.op, "member.contact");
  assert.equal(decoded.contacts.length, 1);
  assert.equal(decoded.contacts[0].accountId, NEWBIE);
  assert.equal(decoded.contacts[0].inboxId, "inbox:newbie");
});

test("member.contact validation rejects contacts missing accountId/inboxId", () => {
  assert.throws(() => contactOp([{ accountId: NEWBIE }]), /each contact requires inboxId/);
  assert.throws(() => contactOp([{ inboxId: "inbox:x" }]), /each contact requires accountId/);
  assert.throws(() => contactOp([]), /contacts required/);
});

test("applying member.contact adds the co-member (add-only) and fires an introduction", async () => {
  const storage = new TestStorageProvider();
  await seedGroup(storage);
  const server = createServer(storage);

  const calls = [];
  server.bus.services.peerLinkProtocol.bootstrapCoMemberLink = (args) => calls.push(args);

  await server.bus.services.groups.handleIncomingGroupOp(
    contactOp([{ accountId: NEWBIE, inboxId: "inbox:newbie", displayName: "Newbie" }]),
    { senderAccountId: SENDER },
  );

  const membership = await server.bus.stores.groupStore.getMembership({
    ownerAccountId: OWNER, groupId: GROUP_ID, accountId: NEWBIE,
  });
  assert.ok(membership, "newbie added to roster");
  assert.equal(membership.state, "active");

  assert.equal(calls.length, 1, "introduction fired once");
  assert.equal(calls[0].peerAccountId, NEWBIE);
  assert.equal(calls[0].peerInboxId, "inbox:newbie");
});

test("member.contact never resurrects a removed member, and fires no introduction for it", async () => {
  const storage = new TestStorageProvider();
  await seedGroup(storage, { newbieState: "removed" });
  const server = createServer(storage);

  const calls = [];
  server.bus.services.peerLinkProtocol.bootstrapCoMemberLink = (args) => calls.push(args);

  await server.bus.services.groups.handleIncomingGroupOp(
    contactOp([{ accountId: NEWBIE, inboxId: "inbox:newbie" }]),
    { senderAccountId: SENDER },
  );

  const membership = await server.bus.stores.groupStore.getMembership({
    ownerAccountId: OWNER, groupId: GROUP_ID, accountId: NEWBIE,
  });
  assert.equal(membership.state, "removed", "removed member stays removed (anti-resurrection)");
  assert.equal(calls.length, 0, "no introduction to a removed member");
});

test("member.contact from a non-member sender is dropped (no roster change, no introduction)", async () => {
  const storage = new TestStorageProvider();
  await seedGroup(storage);
  const server = createServer(storage);

  const calls = [];
  server.bus.services.peerLinkProtocol.bootstrapCoMemberLink = (args) => calls.push(args);

  await server.bus.services.groups.handleIncomingGroupOp(
    contactOp([{ accountId: NEWBIE, inboxId: "inbox:newbie" }]),
    { senderAccountId: "rez:acct:stranger" },
  );

  const membership = await server.bus.stores.groupStore.getMembership({
    ownerAccountId: OWNER, groupId: GROUP_ID, accountId: NEWBIE,
  });
  assert.ok(!membership, "non-member sender cannot add a contact");
  assert.equal(calls.length, 0, "no introduction from a non-member's op");
});
