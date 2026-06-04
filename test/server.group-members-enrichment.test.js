import test from "node:test";
import assert from "node:assert/strict";
import { ChatServerApp } from "../src/server/app/ChatServerApp.js";
import { GroupStore } from "../src/server/storage/ChatGroupStore.js";
import { ContactStore } from "../src/server/storage/ChatContactStore.js";
import { GroupMembersListParams } from "../src/records/index.js";
import { makeSealDispatch } from "./support/sealDispatchDouble.js";

class TestKVStore {
  constructor() { this._data = new Map(); }
  async get(key) { return this._data.get(key); }
  async set(key, value) { this._data.set(key, value); }
  async delete(key) { this._data.delete(key); }
  async keys(prefix) {
    const out = [];
    for (const k of this._data.keys()) {
      if (k.startsWith(prefix)) out.push(k);
    }
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

const FAKE_IDENTITY = {
  accountId: "rez:acct:test-owner",
  publicKeyB64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  privateKeyB64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
};

const OWNER = "rez:acct:test-owner";
const MEMBER_A = "rez:acct:member-a";
const MEMBER_B = "rez:acct:member-b";
const GROUP_ID = "grp_enrichment_test";

test("listGroupMembers enriches members with contact display names", async () => {
  const storage = new TestStorageProvider();
  const clock = () => 1000;

  // Seed group + members
  const groupStore = new GroupStore({ storageProvider: storage, clock });
  await groupStore.ensureGroup({
    ownerAccountId: OWNER,
    groupId: GROUP_ID,
    createdBy: OWNER,
    title: "Test Group",
  });
  await groupStore.ensureMembership({ ownerAccountId: OWNER, groupId: GROUP_ID, accountId: OWNER, role: "admin" });
  await groupStore.ensureMembership({ ownerAccountId: OWNER, groupId: GROUP_ID, accountId: MEMBER_A });
  await groupStore.ensureMembership({ ownerAccountId: OWNER, groupId: GROUP_ID, accountId: MEMBER_B });

  // Seed contacts with display names
  const contactStore = new ContactStore({ storageProvider: storage, clock });
  await contactStore.upsert({
    ownerAccountId: OWNER,
    accountId: MEMBER_A,
    patch: { displayName: "Alice", relationshipState: "active" },
  });
  await contactStore.upsert({
    ownerAccountId: OWNER,
    accountId: MEMBER_B,
    patch: { displayName: "Bob", relationshipState: "active" },
  });

  // Seed a thread so ChatServerApp doesn't complain
  const threadKv = storage.getKeyValueStore(OWNER);
  await threadKv.set("app:threads/" + OWNER + "/th_group_" + GROUP_ID, {
    threadId: "th_group_" + GROUP_ID,
    threadType: "group",
    groupId: GROUP_ID,
    title: "Test Group",
    createdAtMs: 1000,
    updatedAtMs: 1000,
  });

  const server = new ChatServerApp({
    identity: FAKE_IDENTITY,
    uplinks: ["ws://localhost:9999"],
    storageProvider: storage,
    ownerAccountId: OWNER,
    clock,
    sdk: {
      ...makeSealDispatch(),
      getIdentity: () => ({ localInboxId: "inbox:test-owner" }),
    },
  });

  // Call listGroupMembers through the server bus
  const result = await server.bus.call("group.members", "list", new GroupMembersListParams({ groupId: GROUP_ID }));

  assert.ok(result, "result should exist");
  assert.ok(Array.isArray(result.items), "result.items should be an array");

  const memberA = result.items.find((m) => m.accountId === MEMBER_A);
  const memberB = result.items.find((m) => m.accountId === MEMBER_B);

  assert.ok(memberA, "member A should exist");
  assert.ok(memberB, "member B should exist");
  assert.equal(memberA.displayName, "Alice", "member A should have display name from contact");
  assert.equal(memberB.displayName, "Bob", "member B should have display name from contact");

  // Verify serialization round-trip preserves displayName
  const json = JSON.parse(JSON.stringify(result.toJSON()));
  const memberAJson = json.items.find((m) => m.accountId === MEMBER_A);
  assert.equal(memberAJson.displayName, "Alice", "display name should survive JSON round-trip");
});

test("listGroupMembers returns null displayName when no contact exists", async () => {
  const storage = new TestStorageProvider();
  const clock = () => 1000;

  const groupStore = new GroupStore({ storageProvider: storage, clock });
  await groupStore.ensureGroup({ ownerAccountId: OWNER, groupId: GROUP_ID, createdBy: OWNER });
  await groupStore.ensureMembership({ ownerAccountId: OWNER, groupId: GROUP_ID, accountId: OWNER, role: "admin" });
  await groupStore.ensureMembership({ ownerAccountId: OWNER, groupId: GROUP_ID, accountId: MEMBER_A });

  // No contacts seeded — member A has no contact record

  const threadKv = storage.getKeyValueStore(OWNER);
  await threadKv.set("app:threads/" + OWNER + "/th_group_" + GROUP_ID, {
    threadId: "th_group_" + GROUP_ID,
    threadType: "group",
    groupId: GROUP_ID,
    createdAtMs: 1000,
    updatedAtMs: 1000,
  });

  const server = new ChatServerApp({
    identity: FAKE_IDENTITY,
    uplinks: ["ws://localhost:9999"],
    storageProvider: storage,
    ownerAccountId: OWNER,
    clock,
    sdk: {
      ...makeSealDispatch(),
      getIdentity: () => ({ localInboxId: "inbox:test-owner" }),
    },
  });

  const result = await server.bus.call("group.members", "list", new GroupMembersListParams({ groupId: GROUP_ID }));
  const memberA = result.items.find((m) => m.accountId === MEMBER_A);

  assert.ok(memberA, "member A should exist");
  assert.equal(memberA.displayName, null, "displayName should be null when no contact exists");
});
