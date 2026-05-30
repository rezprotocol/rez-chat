import test from "node:test";
import assert from "node:assert/strict";
import { ChatRuntimeConfig } from "../../src/ui/records/ChatRuntimeConfig.js";

test("ChatRuntimeConfig constructs from valid input", () => {
  const r = new ChatRuntimeConfig({ uplinks: ["ws://localhost:8787/ws"], warmSpareCount: 3 });
  assert.deepEqual(r.uplinks, ["ws://localhost:8787/ws"]);
  assert.equal(r.warmSpareCount, 3);
});

test("ChatRuntimeConfig uses wsUrl when uplinks empty", () => {
  const r = new ChatRuntimeConfig({ wsUrl: "ws://host/ws", warmSpareCount: 2 });
  assert.deepEqual(r.uplinks, ["ws://host/ws"]);
  assert.equal(r.warmSpareCount, 2);
});

test("ChatRuntimeConfig defaults warmSpareCount to 2", () => {
  const r = new ChatRuntimeConfig({ uplinks: ["ws://a/ws"] });
  assert.equal(r.warmSpareCount, 2);
});

test("ChatRuntimeConfig accepts null and defaults", () => {
  const r = new ChatRuntimeConfig(null);
  assert.deepEqual(r.uplinks, []);
  assert.equal(r.warmSpareCount, 2);
});

test("ChatRuntimeConfig is frozen", () => {
  const r = new ChatRuntimeConfig({ uplinks: ["ws://a/ws"] });
  assert.ok(Object.isFrozen(r));
});
