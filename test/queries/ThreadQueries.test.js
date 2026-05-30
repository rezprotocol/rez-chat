import test from "node:test";
import assert from "node:assert/strict";
import { ThreadStore } from "../../src/ui/stores/ThreadStore.js";
import { GroupStore } from "../../src/ui/stores/GroupStore.js";
import { ContactStore } from "../../src/ui/stores/ContactStore.js";
import { SessionStore } from "../../src/ui/stores/SessionStore.js";
import { UiStateStore } from "../../src/ui/stores/UiStateStore.js";
import { ThreadQueries } from "../../src/ui/queries/ThreadQueries.js";

function setup() {
  const stores = {
    session: new SessionStore(),
    uiState: new UiStateStore(),
    contacts: new ContactStore(),
    groups: new GroupStore(),
    threads: new ThreadStore(),
  };
  stores.session.setUnlocked({
    accountId: "vault_a",
    deviceId: "dev_a",
    ownerAccountId: "peer_a",
  });
  return { stores, queries: new ThreadQueries({ stores }) };
}

function seedDirect(threads, overrides = {}) {
  threads.upsertThread({
    threadId: "th_dm_b",
    threadType: "direct",
    peerAccountId: "peer_b",
    peerInboxId: "ibx_b",
    accessState: "open",
    ...overrides,
  });
}

function seedGroupThread(threads, overrides = {}) {
  threads.upsertThread({
    threadId: "th_grp_1",
    threadType: "group",
    groupId: "grp_1",
    accessState: "open",
    ...overrides,
  });
}

test("selectedThreadId forwards from UiStateStore", () => {
  const { stores, queries } = setup();
  assert.equal(queries.selectedThreadId(), null);
  stores.uiState.setSelectedThreadId("th_x");
  assert.equal(queries.selectedThreadId(), "th_x");
});

test("displayLabel resolves direct thread via ContactStore", () => {
  const { stores, queries } = setup();
  seedDirect(stores.threads);
  stores.contacts.upsertContact({ accountId: "peer_b", displayName: "Bob", relationshipState: "active" });
  assert.equal(queries.displayLabel("th_dm_b"), "Bob");
});

test("displayLabel returns null when peer has no contact entry", () => {
  const { stores, queries } = setup();
  seedDirect(stores.threads);
  assert.equal(queries.displayLabel("th_dm_b"), null);
});

test("displayLabel resolves group thread via GroupStore title", () => {
  const { stores, queries } = setup();
  seedGroupThread(stores.threads);
  stores.groups.upsertGroup({
    groupId: "grp_1",
    ownerAccountId: "peer_a",
    title: "Dev Crew",
    threadId: "th_grp_1",
    createdBy: "peer_a",
    memberCount: 1,
    createdAtMs: 1000,
    updatedAtMs: 1000,
  });
  assert.equal(queries.displayLabel("th_grp_1"), "Dev Crew");
});

test("displayLabel falls back to thread.title when group missing", () => {
  const { stores, queries } = setup();
  seedGroupThread(stores.threads, { title: "Legacy Title" });
  assert.equal(queries.displayLabel("th_grp_1"), "Legacy Title");
});

test("memberIds for direct returns [self, peer]", () => {
  const { stores, queries } = setup();
  seedDirect(stores.threads);
  assert.deepEqual(queries.memberIds("th_dm_b"), ["peer_a", "peer_b"]);
});

test("memberIds for group asks GroupStore", () => {
  const { stores, queries } = setup();
  seedGroupThread(stores.threads);
  stores.groups.upsertGroup({
    groupId: "grp_1",
    ownerAccountId: "peer_a",
    title: "G",
    threadId: "th_grp_1",
    createdBy: "peer_a",
    memberCount: 2,
    createdAtMs: 1000,
    updatedAtMs: 1000,
  });
  stores.groups.replaceMembers("grp_1", [
    { groupId: "grp_1", ownerAccountId: "peer_a", accountId: "peer_a", role: "admin", state: "active", joinedAtMs: 1, updatedAtMs: 1 },
    { groupId: "grp_1", ownerAccountId: "peer_a", accountId: "peer_b", role: "member", state: "active", joinedAtMs: 1, updatedAtMs: 1 },
  ]);
  assert.deepEqual(queries.memberIds("th_grp_1").sort(), ["peer_a", "peer_b"]);
});

test("isReadableByMe true when thread exists", () => {
  const { stores, queries } = setup();
  seedDirect(stores.threads);
  assert.equal(queries.isReadableByMe("th_dm_b"), true);
  assert.equal(queries.isReadableByMe("th_missing"), false);
});

test("isWritable false for locked thread", () => {
  const { stores, queries } = setup();
  seedDirect(stores.threads, { accessState: "locked" });
  assert.equal(queries.isWritable("th_dm_b"), false);
});

test("isWritable false when self is not active group member", () => {
  const { stores, queries } = setup();
  seedGroupThread(stores.threads);
  stores.groups.upsertGroup({
    groupId: "grp_1",
    ownerAccountId: "peer_a",
    title: "G",
    threadId: "th_grp_1",
    createdBy: "peer_a",
    memberCount: 1,
    createdAtMs: 1000,
    updatedAtMs: 1000,
  });
  assert.equal(queries.isWritable("th_grp_1"), false);
  stores.groups.replaceMembers("grp_1", [
    { groupId: "grp_1", ownerAccountId: "peer_a", accountId: "peer_a", role: "admin", state: "active", joinedAtMs: 1, updatedAtMs: 1 },
  ]);
  assert.equal(queries.isWritable("th_grp_1"), true);
});

test("presentationContext bundles derived fields", () => {
  const { stores, queries } = setup();
  seedDirect(stores.threads);
  stores.contacts.upsertContact({ accountId: "peer_b", displayName: "Bob", relationshipState: "active" });
  const ctx = queries.presentationContext("th_dm_b");
  assert.equal(ctx.label, "Bob");
  assert.equal(ctx.readable, true);
  assert.equal(ctx.writable, true);
  assert.deepEqual(ctx.memberIds, ["peer_a", "peer_b"]);
});

test("constructor throws without stores", () => {
  assert.throws(() => new ThreadQueries(), /requires \{ stores \}/);
});
