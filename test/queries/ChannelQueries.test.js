import test from "node:test";
import assert from "node:assert/strict";
import { ChannelStore } from "../../src/ui/stores/ChannelStore.js";
import { ChannelQueries } from "../../src/ui/queries/ChannelQueries.js";

function setup() {
  const stores = { channels: new ChannelStore() };
  return { stores, queries: new ChannelQueries({ stores }) };
}

test("displayLabel: 'general' for null/empty (the canonical id)", () => {
  const { queries } = setup();
  assert.equal(queries.displayLabel("grp_1", null), "general");
  assert.equal(queries.displayLabel("grp_1", ""), "general");
  // The string "general" is a DISTINCT channel id, not the canonical
  // general bucket — falls through to channel-record lookup.
  assert.equal(queries.displayLabel("grp_1", "general"), "general");
});

test("displayLabel: returns channelId when no label", () => {
  const { stores, queries } = setup();
  stores.channels.upsertChannel({
    channelId: "dev",
    groupId: "grp_1",
    ownerAccountId: "peer_a",
    createdAtMs: 1,
  });
  assert.equal(queries.displayLabel("grp_1", "dev"), "dev");
});

test("displayLabel: returns label when channel has one", () => {
  const { stores, queries } = setup();
  stores.channels.upsertChannel({
    channelId: "dev",
    groupId: "grp_1",
    ownerAccountId: "peer_a",
    label: "Dev Talk",
    createdAtMs: 1,
  });
  assert.equal(queries.displayLabel("grp_1", "dev"), "Dev Talk");
});

test("constructor throws without stores", () => {
  assert.throws(() => new ChannelQueries(), /requires \{ stores \}/);
});
