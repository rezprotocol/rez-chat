import test from "node:test";
import assert from "node:assert/strict";
import { GroupStore } from "../../src/ui/stores/GroupStore.js";

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

test("GroupStore.getMember returns matching row", () => {
  const groups = new GroupStore();
  seedGroup(groups, { members: [{ accountId: "peer_a" }, { accountId: "peer_b" }] });
  assert.equal(groups.getMember("grp_1", "peer_a").accountId, "peer_a");
  assert.equal(groups.getMember("grp_1", "peer_b").accountId, "peer_b");
  assert.equal(groups.getMember("grp_1", "peer_x"), null);
  assert.equal(groups.getMember("", "peer_a"), null);
  assert.equal(groups.getMember("grp_1", ""), null);
});

test("GroupStore.getMemberIds extracts active member ids", () => {
  const groups = new GroupStore();
  seedGroup(groups, {
    members: [
      { accountId: "peer_a", role: "admin" },
      { accountId: "peer_b" },
      { accountId: "peer_c" },
    ],
  });
  const ids = groups.getMemberIds("grp_1").sort();
  assert.deepEqual(ids, ["peer_a", "peer_b", "peer_c"]);
});

test("GroupStore.isAdmin true for founder even without explicit role", () => {
  const groups = new GroupStore();
  seedGroup(groups, {
    createdBy: "peer_a",
    members: [
      { accountId: "peer_a", role: "member" }, // stale row says "member"
      { accountId: "peer_b" },
    ],
  });
  assert.equal(groups.isAdmin("grp_1", "peer_a"), true);
});

test("GroupStore.isAdmin true for explicit admin role", () => {
  const groups = new GroupStore();
  seedGroup(groups, {
    createdBy: "peer_a",
    members: [
      { accountId: "peer_a", role: "admin" },
      { accountId: "peer_b", role: "admin" },
    ],
  });
  assert.equal(groups.isAdmin("grp_1", "peer_b"), true);
});

test("GroupStore.isAdmin false for plain member", () => {
  const groups = new GroupStore();
  seedGroup(groups, {
    createdBy: "peer_a",
    members: [
      { accountId: "peer_a", role: "admin" },
      { accountId: "peer_b", role: "member" },
    ],
  });
  assert.equal(groups.isAdmin("grp_1", "peer_b"), false);
});

test("GroupStore.isAdmin guards empty ids", () => {
  const groups = new GroupStore();
  seedGroup(groups, { members: [{ accountId: "peer_a", role: "admin" }] });
  assert.equal(groups.isAdmin("", "peer_a"), false);
  assert.equal(groups.isAdmin("grp_1", ""), false);
});
