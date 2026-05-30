import test from "node:test";
import assert from "node:assert/strict";
import { ChannelStore } from "../src/server/storage/ChatChannelStore.js";

class TestKVStore {
  constructor() { this._data = new Map(); }
  async get(key) { return this._data.get(key); }
  async set(key, value) { this._data.set(key, value); }
  async delete(key) { this._data.delete(key); }
  async keys(prefix) {
    const out = [];
    for (const k of this._data.keys()) {
      if (k.startsWith(prefix)) out.push(k);
    }
    return out;
  }
}
class TestStorageProvider {
  constructor() { this._stores = new Map(); }
  getKeyValueStore(name) {
    if (!this._stores.has(name)) this._stores.set(name, new TestKVStore());
    return this._stores.get(name);
  }
}

const OWNER = "rez:acct:owner";
const GROUP = "grp_1";

function makeStore(clockMs = 1000) {
  let now = clockMs;
  const clock = () => now;
  const store = new ChannelStore({ storageProvider: new TestStorageProvider(), clock });
  return {
    store,
    advance(ms) { now += ms; },
    setClock(ms) { now = ms; },
  };
}

test("ChannelStore.ensureChannel creates and is idempotent", async () => {
  const { store } = makeStore();
  const first = await store.ensureChannel({ ownerAccountId: OWNER, groupId: GROUP, channelId: "dev" });
  assert.equal(first.created, true);
  assert.equal(first.channel.channelId, "dev");
  assert.equal(first.channel.groupId, GROUP);
  assert.equal(first.channel.deletedAtMs, null);

  const second = await store.ensureChannel({ ownerAccountId: OWNER, groupId: GROUP, channelId: "dev" });
  assert.equal(second.created, false);
  assert.equal(second.channel.channelId, "dev");
});

test("ChannelStore.ensureChannel rejects invalid slugs", async () => {
  const { store } = makeStore();
  await assert.rejects(() =>
    store.ensureChannel({ ownerAccountId: OWNER, groupId: GROUP, channelId: "Bad Name" }));
  await assert.rejects(() =>
    store.ensureChannel({ ownerAccountId: OWNER, groupId: GROUP, channelId: "" }));
});

test("ChannelStore.listChannels returns active channels sorted alphabetically", async () => {
  const ctx = makeStore(1000);
  await ctx.store.ensureChannel({ ownerAccountId: OWNER, groupId: GROUP, channelId: "zebra", createdAtMs: 2000 });
  await ctx.store.ensureChannel({ ownerAccountId: OWNER, groupId: GROUP, channelId: "alpha", createdAtMs: 3000 });
  const channels = await ctx.store.listChannels({ ownerAccountId: OWNER, groupId: GROUP });
  assert.deepEqual(channels.map((c) => c.channelId), ["alpha", "zebra"]);
});

test("ChannelStore.tombstoneChannel marks deletedAtMs; listChannels hides by default", async () => {
  const ctx = makeStore(1000);
  await ctx.store.ensureChannel({ ownerAccountId: OWNER, groupId: GROUP, channelId: "dev" });
  await ctx.store.tombstoneChannel({ ownerAccountId: OWNER, groupId: GROUP, channelId: "dev", deletedAtMs: 2000 });

  const active = await ctx.store.listChannels({ ownerAccountId: OWNER, groupId: GROUP });
  assert.equal(active.length, 0);

  const all = await ctx.store.listChannels({ ownerAccountId: OWNER, groupId: GROUP, includeDeleted: true });
  assert.equal(all.length, 1);
  assert.equal(all[0].deletedAtMs, 2000);
});

test("ChannelStore.tombstoneChannel is idempotent for already-tombstoned rows", async () => {
  const ctx = makeStore(1000);
  await ctx.store.ensureChannel({ ownerAccountId: OWNER, groupId: GROUP, channelId: "dev" });
  const first = await ctx.store.tombstoneChannel({ ownerAccountId: OWNER, groupId: GROUP, channelId: "dev", deletedAtMs: 2000 });
  assert.equal(first.tombstoned, true);
  const second = await ctx.store.tombstoneChannel({ ownerAccountId: OWNER, groupId: GROUP, channelId: "dev", deletedAtMs: 3000 });
  assert.equal(second.tombstoned, false);
  assert.equal(second.channel.deletedAtMs, 2000);
});

test("ChannelStore.ensureChannel revives a tombstoned channel with fresh createdAtMs", async () => {
  const ctx = makeStore(1000);
  await ctx.store.ensureChannel({ ownerAccountId: OWNER, groupId: GROUP, channelId: "dev", createdAtMs: 1000 });
  await ctx.store.tombstoneChannel({ ownerAccountId: OWNER, groupId: GROUP, channelId: "dev", deletedAtMs: 2000 });

  const revived = await ctx.store.ensureChannel({ ownerAccountId: OWNER, groupId: GROUP, channelId: "dev", createdAtMs: 3000 });
  assert.equal(revived.created, true);
  assert.equal(revived.channel.deletedAtMs, null);
  assert.equal(revived.channel.createdAtMs, 3000);
});

test("ChannelStore isolates channels by group and owner", async () => {
  const ctx = makeStore(1000);
  await ctx.store.ensureChannel({ ownerAccountId: OWNER, groupId: "grp_a", channelId: "dev" });
  await ctx.store.ensureChannel({ ownerAccountId: OWNER, groupId: "grp_b", channelId: "ops" });
  await ctx.store.ensureChannel({ ownerAccountId: "rez:acct:other", groupId: "grp_a", channelId: "secret" });

  const groupAForOwner = await ctx.store.listChannels({ ownerAccountId: OWNER, groupId: "grp_a" });
  assert.deepEqual(groupAForOwner.map((c) => c.channelId), ["dev"]);

  const groupAForOther = await ctx.store.listChannels({ ownerAccountId: "rez:acct:other", groupId: "grp_a" });
  assert.deepEqual(groupAForOther.map((c) => c.channelId), ["secret"]);
});

test("ChannelStore.getChannel returns null for unknown channels", async () => {
  const ctx = makeStore(1000);
  const missing = await ctx.store.getChannel({ ownerAccountId: OWNER, groupId: GROUP, channelId: "never" });
  assert.equal(missing, null);
});
