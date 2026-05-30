import test from "node:test";
import assert from "node:assert/strict";
import { ChannelStore } from "../../src/ui/stores/ChannelStore.js";

test("ChannelStore.getChannel returns matching record", () => {
  const channels = new ChannelStore();
  channels.upsertChannel({
    channelId: "dev",
    groupId: "grp_1",
    ownerAccountId: "peer_a",
    createdAtMs: 1,
  });
  assert.equal(channels.getChannel("grp_1", "dev").channelId, "dev");
  assert.equal(channels.getChannel("grp_1", "missing"), null);
  assert.equal(channels.getChannel("", "dev"), null);
});

test("ChannelStore.getChannels excludes tombstoned, sorted alpha", () => {
  const channels = new ChannelStore();
  channels.upsertChannel({ channelId: "zeta", groupId: "grp_1", ownerAccountId: "peer_a", createdAtMs: 1 });
  channels.upsertChannel({ channelId: "alpha", groupId: "grp_1", ownerAccountId: "peer_a", createdAtMs: 2 });
  channels.upsertChannel({ channelId: "mid", groupId: "grp_1", ownerAccountId: "peer_a", createdAtMs: 3 });
  channels.removeChannel("grp_1", "mid");
  const ids = channels.getChannels("grp_1").map((c) => c.channelId);
  assert.deepEqual(ids, ["alpha", "zeta"]);
});

test("ChannelStore.isLoaded tracks per-group state", () => {
  const channels = new ChannelStore();
  assert.equal(channels.isLoaded("grp_1"), false);
  channels.replaceChannels("grp_1", []);
  assert.equal(channels.isLoaded("grp_1"), true);
  assert.equal(channels.isLoaded("grp_2"), false);
});
