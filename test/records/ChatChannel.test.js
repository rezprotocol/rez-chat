import test from "node:test";
import assert from "node:assert/strict";
import { ChatChannel } from "../../src/records/domain/ChatChannel.js";

test("ChatChannel constructs from valid input", () => {
  const r = new ChatChannel({
    channelId: "dev",
    groupId: "grp_1",
    ownerAccountId: "acc_self",
    createdAtMs: 1000,
  });
  assert.equal(r.channelId, "dev");
  assert.equal(r.groupId, "grp_1");
  assert.equal(r.ownerAccountId, "acc_self");
  assert.equal(r.createdAtMs, 1000);
  assert.equal(r.deletedAtMs, null);
});

test("ChatChannel carries deletedAtMs when tombstoned", () => {
  const r = new ChatChannel({
    channelId: "dev",
    groupId: "grp_1",
    ownerAccountId: "acc_self",
    createdAtMs: 1000,
    deletedAtMs: 2000,
  });
  assert.equal(r.deletedAtMs, 2000);
});

test("ChatChannel throws when channelId missing", () => {
  assert.throws(() => new ChatChannel({ groupId: "grp_1", ownerAccountId: "acc_self" }));
});

test("ChatChannel throws when groupId missing", () => {
  assert.throws(() => new ChatChannel({ channelId: "dev", ownerAccountId: "acc_self" }));
});

test("ChatChannel throws when ownerAccountId missing", () => {
  assert.throws(() => new ChatChannel({ channelId: "dev", groupId: "grp_1" }));
});

test("ChatChannel is frozen", () => {
  const r = new ChatChannel({ channelId: "dev", groupId: "grp_1", ownerAccountId: "acc_self" });
  assert.ok(Object.isFrozen(r));
});
