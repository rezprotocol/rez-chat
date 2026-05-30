import test from "node:test";
import assert from "node:assert/strict";
import { GroupStore } from "../../src/ui/stores/GroupStore.js";
import { SessionStore } from "../../src/ui/stores/SessionStore.js";
import { GroupQueries } from "../../src/ui/queries/GroupQueries.js";

function setupWithSelf({ selfChat = "peer_a" } = {}) {
  const stores = {
    session: new SessionStore(),
    groups: new GroupStore(),
  };
  stores.session.setUnlocked({
    accountId: "vault_a",
    deviceId: "dev_a",
    ownerAccountId: selfChat,
    localInboxId: "ibx_a",
  });
  return { stores, queries: new GroupQueries({ stores }) };
}

function seedGroup(groups, { groupId = "grp_1", createdBy = "peer_a", title = "G", members = [] } = {}) {
  groups.upsertGroup({
    groupId,
    ownerAccountId: createdBy,
    title,
    threadId: "th_" + groupId,
    createdBy,
    memberCount: members.length,
    createdAtMs: 1000,
    updatedAtMs: 1000,
  });
  groups.replaceMembers(
    groupId,
    members.map((m) => ({
      groupId,
      ownerAccountId: createdBy,
      accountId: m.accountId,
      role: m.role || "member",
      state: m.state || "active",
      joinedAtMs: 1000,
      updatedAtMs: 1000,
    }))
  );
}

test("isSelfAdmin: true for founder even when explicit role says member", () => {
  const { stores, queries } = setupWithSelf({ selfChat: "peer_a" });
  seedGroup(stores.groups, {
    createdBy: "peer_a",
    members: [{ accountId: "peer_a", role: "member" }, { accountId: "peer_b" }],
  });
  assert.equal(queries.isSelfAdmin("grp_1"), true);
});

test("isSelfAdmin: true for explicit admin role", () => {
  const { stores, queries } = setupWithSelf({ selfChat: "peer_b" });
  seedGroup(stores.groups, {
    createdBy: "peer_a",
    members: [
      { accountId: "peer_a", role: "admin" },
      { accountId: "peer_b", role: "admin" },
    ],
  });
  assert.equal(queries.isSelfAdmin("grp_1"), true);
});

test("isSelfAdmin: false for plain member", () => {
  const { stores, queries } = setupWithSelf({ selfChat: "peer_b" });
  seedGroup(stores.groups, {
    createdBy: "peer_a",
    members: [
      { accountId: "peer_a", role: "admin" },
      { accountId: "peer_b", role: "member" },
    ],
  });
  assert.equal(queries.isSelfAdmin("grp_1"), false);
});

test("isSelfAdmin: false when no session unlocked", () => {
  const stores = { session: new SessionStore(), groups: new GroupStore() };
  const queries = new GroupQueries({ stores });
  seedGroup(stores.groups, { members: [{ accountId: "peer_a", role: "admin" }] });
  assert.equal(queries.isSelfAdmin("grp_1"), false);
});

test("isSelfAdmin: uses chatAccountId (ownerAccountId), NOT vaultAccountId", () => {
  // Critical foot-gun check: vault id is "vault_a", peerlink id is "peer_a".
  // Group membership is keyed by peerlink id; if the query reads the wrong
  // slot, the founder check fails (vault_a is not in the member list).
  const { stores, queries } = setupWithSelf({ selfChat: "peer_a" });
  seedGroup(stores.groups, {
    createdBy: "peer_a",
    members: [{ accountId: "peer_a", role: "admin" }],
  });
  assert.equal(queries.isSelfAdmin("grp_1"), true);
});

test("selfMember resolves via session chatAccountId", () => {
  const { stores, queries } = setupWithSelf({ selfChat: "peer_a" });
  seedGroup(stores.groups, { members: [{ accountId: "peer_a" }, { accountId: "peer_b" }] });
  assert.equal(queries.selfMember("grp_1").accountId, "peer_a");
});

test("selfMember: null when self not in group", () => {
  const { stores, queries } = setupWithSelf({ selfChat: "peer_x" });
  seedGroup(stores.groups, { members: [{ accountId: "peer_a" }, { accountId: "peer_b" }] });
  assert.equal(queries.selfMember("grp_1"), null);
});

test("canSelfRename mirrors isSelfAdmin", () => {
  const { stores, queries } = setupWithSelf({ selfChat: "peer_a" });
  seedGroup(stores.groups, { createdBy: "peer_a", members: [{ accountId: "peer_a" }] });
  assert.equal(queries.canSelfRename("grp_1"), true);
});

test("canSelfKick: forbids kicking self", () => {
  const { stores, queries } = setupWithSelf({ selfChat: "peer_a" });
  seedGroup(stores.groups, {
    createdBy: "peer_a",
    members: [{ accountId: "peer_a", role: "admin" }, { accountId: "peer_b" }],
  });
  assert.equal(queries.canSelfKick("grp_1", "peer_a"), false);
  assert.equal(queries.canSelfKick("grp_1", "peer_b"), true);
  assert.equal(queries.canSelfKick("grp_1", "peer_x"), false);
});

test("canSelfKick: refuses non-admin viewer", () => {
  const { stores, queries } = setupWithSelf({ selfChat: "peer_b" });
  seedGroup(stores.groups, {
    createdBy: "peer_a",
    members: [{ accountId: "peer_a", role: "admin" }, { accountId: "peer_b" }],
  });
  assert.equal(queries.canSelfKick("grp_1", "peer_a"), false);
});

test("canSelfSetRole mirrors canSelfKick", () => {
  const { stores, queries } = setupWithSelf({ selfChat: "peer_a" });
  seedGroup(stores.groups, {
    createdBy: "peer_a",
    members: [{ accountId: "peer_a", role: "admin" }, { accountId: "peer_b" }],
  });
  assert.equal(queries.canSelfSetRole("grp_1", "peer_a"), false);
  assert.equal(queries.canSelfSetRole("grp_1", "peer_b"), true);
  assert.equal(queries.canSelfSetRole("grp_1", "peer_x"), false);
});

test("canSelfDeleteChannel: forbids general and empty", () => {
  const { stores, queries } = setupWithSelf({ selfChat: "peer_a" });
  seedGroup(stores.groups, { createdBy: "peer_a", members: [{ accountId: "peer_a" }] });
  assert.equal(queries.canSelfDeleteChannel("grp_1", "general"), false);
  assert.equal(queries.canSelfDeleteChannel("grp_1", "GENERAL"), false);
  assert.equal(queries.canSelfDeleteChannel("grp_1", null), false);
  assert.equal(queries.canSelfDeleteChannel("grp_1", ""), false);
  assert.equal(queries.canSelfDeleteChannel("grp_1", "dev"), true);
});

test("canSelfCreateChannel: false for non-admin", () => {
  const { stores, queries } = setupWithSelf({ selfChat: "peer_b" });
  seedGroup(stores.groups, {
    createdBy: "peer_a",
    members: [
      { accountId: "peer_a", role: "admin" },
      { accountId: "peer_b", role: "member" },
    ],
  });
  assert.equal(queries.canSelfCreateChannel("grp_1"), false);
});

test("constructor throws without stores", () => {
  assert.throws(() => new GroupQueries(), /requires \{ stores \}/);
  assert.throws(() => new GroupQueries({}), /requires \{ stores \}/);
});
