import test from "node:test";
import assert from "node:assert/strict";
import { ChatInvite } from "../../src/records/domain/ChatInvite.js";

test("ChatInvite constructs from valid input", () => {
  const r = new ChatInvite({
    inviteId: "inv_1",
    kind: "direct",
    expiresAtMs: 9999,
    maxUses: 3,
    uses: 1,
    status: "active",
  });
  assert.equal(r.inviteId, "inv_1");
  assert.equal(r.kind, "direct");
  assert.equal(r.expiresAtMs, 9999);
  assert.equal(r.maxUses, 3);
  assert.equal(r.uses, 1);
  assert.equal(r.status, "active");
  assert.ok(Object.isFrozen(r));
});

test("ChatInvite throws when inviteId missing", () => {
  assert.throws(() => new ChatInvite({ kind: "direct" }));
});

test("ChatInvite defaults kind to direct", () => {
  const r = new ChatInvite({ inviteId: "inv_2" });
  assert.equal(r.kind, "direct");
  assert.equal(r.groupId, "");
});

test("ChatInvite accepts group kind with groupId", () => {
  const r = new ChatInvite({ inviteId: "inv_3", kind: "group", groupId: "grp_1" });
  assert.equal(r.kind, "group");
  assert.equal(r.groupId, "grp_1");
});
