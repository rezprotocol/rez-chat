import test from "node:test";
import assert from "node:assert/strict";
import { AccountRegistryData } from "../../src/ui/records/AccountRegistryData.js";

test("AccountRegistryData constructs from valid input", () => {
  const r = new AccountRegistryData({
    accountIds: ["id1", "id2"],
    hints: { id1: { label: "A" } },
  });
  assert.deepEqual(r.accountIds, ["id1", "id2"]);
  assert.deepEqual(r.hints, { id1: { label: "A" } });
});

test("AccountRegistryData filters empty account ids", () => {
  const r = new AccountRegistryData({
    accountIds: ["id1", "", "  ", "id2"],
    hints: {},
  });
  assert.deepEqual(r.accountIds, ["id1", "id2"]);
});

test("AccountRegistryData accepts null and defaults to empty", () => {
  const r = new AccountRegistryData(null);
  assert.deepEqual(r.accountIds, []);
  assert.deepEqual(r.hints, {});
});

test("AccountRegistryData is frozen", () => {
  const r = new AccountRegistryData({ accountIds: ["a"], hints: {} });
  assert.ok(Object.isFrozen(r));
});
