import test from "node:test";
import assert from "node:assert/strict";
import { ChatContact } from "../../src/records/domain/ChatContact.js";

test("ChatContact constructs from valid input", () => {
  const r = new ChatContact({ accountId: "acc_1", displayName: "Alice" });
  assert.equal(r.accountId, "acc_1");
  assert.equal(r.displayName, "Alice");
  assert.equal(r.relationshipState, "active");
});

test("ChatContact throws when accountId missing", () => {
  assert.throws(() => new ChatContact({ displayName: "No id" }));
});

test("ChatContact is frozen", () => {
  const r = new ChatContact({ accountId: "acc_1" });
  assert.ok(Object.isFrozen(r));
});
