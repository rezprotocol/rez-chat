import test from "node:test";
import assert from "node:assert/strict";

import { ChatServerApp } from "../src/server/app/ChatServerApp.js";
import { GroupStore } from "../src/server/storage/ChatGroupStore.js";
import { GroupOpPayloadV1, groupOpPayloadToBytes } from "../src/records/payloads/GroupOpPayloadV1.js";
import { makeSealDispatch } from "./support/sealDispatchDouble.js";
import { permissiveAccountAuthority, testConsentProof } from "./support/memberConsentDouble.js";

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
    accountAuthority: permissiveAccountAuthority(),
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
    contactOp([{ accountId: NEWBIE, inboxId: "inbox:newbie", displayName: "Newbie", joinProof: testConsentProof() }]),
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

test("member.contact UPGRADES a nameless existing row (name+proof) and EMITS group.members.updated", async () => {
  // Regression: ensureGroupThread adds the inviter/creator row nameless+proofless
  // at accept; the verified member.contact is the first time we learn their
  // signed name. ensureMembership upgrades the row (created:false), so the applier
  // must emit on `upgraded` — otherwise the name lands in the store but the roster
  // UI shows the bare account id forever (live dev:three bug, 2026-06-10).
  const storage = new TestStorageProvider();
  const groupStore = await seedGroup(storage);
  // NEWBIE pre-exists as an active member with NO displayName and NO proof
  // (exactly the shape ensureGroupThread leaves the inviter row in).
  await groupStore.ensureMembership({ ownerAccountId: OWNER, groupId: GROUP_ID, accountId: NEWBIE, role: "member" });
  const server = createServer(storage);
  server.bus.services.peerLinkProtocol.bootstrapCoMemberLink = () => {};

  const emitted = [];
  server.bus.on("group.members.updated", (payload) => emitted.push(payload));

  await server.bus.services.groups.handleIncomingGroupOp(
    contactOp([{ accountId: NEWBIE, inboxId: "inbox:newbie", displayName: "Newbie", joinProof: testConsentProof() }]),
    { senderAccountId: SENDER },
  );

  const membership = await server.bus.stores.groupStore.getMembership({
    ownerAccountId: OWNER, groupId: GROUP_ID, accountId: NEWBIE,
  });
  assert.equal(membership.displayName, "Newbie", "nameless row upgraded with the verified name");
  assert.equal(emitted.length, 1, "members.updated emitted on name upgrade (not only on create)");
  assert.equal(emitted[0].groupId, GROUP_ID);
});

test("member.contact records the co-member as a `known` account (name in the ONE table, NOT an active contact)", async () => {
  // SSOT: a verified co-member's name lands in the account table (the single
  // place a name lives, keyed by accountId) as a `known` row — so the roster
  // resolves the name by one lookup, without duplicating it onto the membership
  // row and without violating strict contacts/groups separation (no DM thread).
  const storage = new TestStorageProvider();
  await seedGroup(storage);
  const server = createServer(storage);
  server.bus.services.peerLinkProtocol.bootstrapCoMemberLink = () => {};

  await server.bus.services.groups.handleIncomingGroupOp(
    contactOp([{ accountId: NEWBIE, inboxId: "inbox:newbie", displayName: "Newbie", joinProof: testConsentProof() }]),
    { senderAccountId: SENDER },
  );

  const listed = await server.bus.services.contacts.listContacts({});
  const row = (listed.items || []).find((c) => c.accountId === NEWBIE);
  assert.ok(row, "co-member recorded in the account table");
  assert.equal(row.relationshipState, "known", "recorded as a name-only `known` row");
  assert.equal(row.displayName, "Newbie", "with the cryptographically-verified name");
  assert.equal(await server.bus.services.contacts.isActiveContact(NEWBIE), false,
    "a `known` co-member is NOT an active contact (no DM thread, hidden from the active list)");
});

test("member.contact with an UNVERIFIABLE name does not write a known account row", async () => {
  // joinProof is the cryptographic guarantee the name is real; without it (here,
  // a non-member sender whose op is dropped) nothing is recorded.
  const storage = new TestStorageProvider();
  await seedGroup(storage);
  const server = createServer(storage);
  server.bus.services.peerLinkProtocol.bootstrapCoMemberLink = () => {};

  await server.bus.services.groups.handleIncomingGroupOp(
    contactOp([{ accountId: NEWBIE, inboxId: "inbox:newbie", displayName: "Spoofed" }]),
    { senderAccountId: "rez:acct:stranger" },
  );

  const listed = await server.bus.services.contacts.listContacts({});
  assert.ok(!(listed.items || []).some((c) => c.accountId === NEWBIE),
    "no account row from an unverifiable member.contact");
});

test("ensureKnownAccount never downgrades an existing active contact (name + relationship preserved)", async () => {
  const storage = new TestStorageProvider();
  await seedGroup(storage);
  const server = createServer(storage);
  await server.bus.services.contacts.ensureActiveContact({ accountId: NEWBIE, displayName: "Real Newbie" });

  const result = await server.bus.services.contacts.ensureKnownAccount({ accountId: NEWBIE, displayName: "Newbie" });
  assert.equal(result.relationshipState, "active", "active relationship is NOT downgraded to known");
  assert.equal(result.displayName, "Real Newbie", "active contact's own name is preserved");
});

test("member.contact never resurrects a removed member, and fires no introduction for it", async () => {
  const storage = new TestStorageProvider();
  await seedGroup(storage, { newbieState: "removed" });
  const server = createServer(storage);

  const calls = [];
  server.bus.services.peerLinkProtocol.bootstrapCoMemberLink = (args) => calls.push(args);

  await server.bus.services.groups.handleIncomingGroupOp(
    contactOp([{ accountId: NEWBIE, inboxId: "inbox:newbie", joinProof: testConsentProof() }]),
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
