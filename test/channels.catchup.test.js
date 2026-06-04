// Channel catch-up: when peer-link establishes for a group, the sender
// re-fans out every known channel to the new peer. Closes the race where
// a channel.create fan-out missed a member whose group membership was
// not yet registered on the sender at create-time.

import test from "node:test";
import assert from "node:assert/strict";
import { ChatServerApp } from "../src/server/app/ChatServerApp.js";
import { makeSealDispatch } from "./support/sealDispatchDouble.js";

class TestKVStore {
  constructor() { this._data = new Map(); }
  async get(key) { return this._data.get(key); }
  async set(key, value) { this._data.set(key, value); }
  async delete(key) { this._data.delete(key); }
  async keys(prefix) {
    const out = [];
    for (const k of this._data.keys()) if (k.startsWith(prefix)) out.push(k);
    return out;
  }
}
class TestStorageProvider {
  constructor() { this._stores = new Map(); }
  getKeyValueStore(name) {
    if (!this._stores.has(name)) this._stores.set(name, new TestKVStore());
    return this._stores.get(name);
  }
  getObjectStore() { return { deposit: async () => ({}), list: async () => [] }; }
  getMailboxStore() { return { deposit: async () => ({}), poll: async () => [] }; }
}

const FAKE_KEYS = {
  publicKeyB64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  privateKeyB64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
};

const ALICE = "rez:acct:alice";
const BOB = "rez:acct:bob";

function makeServer({ ownerAccountId, storage, sendCapture, clock }) {
  const sdk = {
    ...makeSealDispatch({ onSend: (opts) => { if (Array.isArray(sendCapture)) sendCapture.push(opts); } }),
    getIdentity: () => ({ localInboxId: "inbox:" + ownerAccountId }),
  };
  return new ChatServerApp({
    identity: { ...FAKE_KEYS, accountId: ownerAccountId, deviceId: "dev:" + ownerAccountId },
    uplinks: ["ws://localhost:9999"],
    storageProvider: storage,
    ownerAccountId,
    clock,
    sdk,
  });
}

test("fanoutChannelsToPeer re-sends all active channels as channel.create ops", async () => {
  let now = 1000;
  const sent = [];
  const aliceStorage = new TestStorageProvider();
  const alice = makeServer({ ownerAccountId: ALICE, storage: aliceStorage, sendCapture: sent, clock: () => (now += 1) });

  // Seed: Alice has a group with two channels, Bob is already a member.
  const created = await alice.bus.services.groups.createGroup({ title: "Crew" });
  const groupId = created.groupId;
  await alice.bus.stores.groupStore.ensureMembership({
    ownerAccountId: ALICE, groupId, accountId: BOB, role: "member",
  });
  await alice.bus.services.channels.createChannel({ groupId, channelId: "dev" });
  await alice.bus.services.channels.createChannel({ groupId, channelId: "planning" });

  // Initial create already fanned out to Bob (already a member). Reset
  // the capture so we measure ONLY the catch-up fan-out below.
  sent.length = 0;

  // Catch-up: re-fanout to Bob (simulating his peer-link establishing).
  await alice.bus.services.channels.fanoutChannelsToPeer({ groupId, peerAccountId: BOB });

  assert.equal(sent.length, 2, "two channel.create ops sent to Bob");
  for (const entry of sent) {
    assert.equal(entry.peerAccountId, BOB, "target is Bob");
  }
  // Decode the bodies and check they're channel.create ops for our channels.
  const decoded = sent.map((s) => JSON.parse(Buffer.from(s.plaintextBodyBytes).toString("utf8")));
  const channels = decoded.map((d) => d.channelId).sort();
  assert.deepEqual(channels, ["dev", "planning"], "both channels re-sent");
  for (const d of decoded) {
    assert.equal(d.op, "channel.create");
    assert.equal(d.groupId, groupId);
  }
});

test("fanoutChannelsToPeer skips self and no-op for unknown group", async () => {
  let now = 1000;
  const sent = [];
  const aliceStorage = new TestStorageProvider();
  const alice = makeServer({ ownerAccountId: ALICE, storage: aliceStorage, sendCapture: sent, clock: () => (now += 1) });

  await alice.bus.services.channels.fanoutChannelsToPeer({ groupId: "grp_unknown", peerAccountId: BOB });
  assert.equal(sent.length, 0, "unknown group → nothing to fanout");

  const created = await alice.bus.services.groups.createGroup({ title: "Solo" });
  await alice.bus.services.channels.createChannel({ groupId: created.groupId, channelId: "dev" });
  sent.length = 0;
  await alice.bus.services.channels.fanoutChannelsToPeer({ groupId: created.groupId, peerAccountId: ALICE });
  assert.equal(sent.length, 0, "self target → skipped");
});

test("ensureFromObservedMessage sends channels.sync_request when channel is new", async () => {
  let now = 1000;
  const sent = [];
  const storage = new TestStorageProvider();
  const alice = makeServer({ ownerAccountId: ALICE, storage, sendCapture: sent, clock: () => (now += 1) });

  // Alice has a group; Bob is a member.
  const created = await alice.bus.services.groups.createGroup({ title: "Crew" });
  const groupId = created.groupId;
  await alice.bus.stores.groupStore.ensureMembership({
    ownerAccountId: ALICE, groupId, accountId: BOB, role: "member",
  });

  // Bob (in a real scenario) sends a message tagged "design" — Alice
  // has never seen this channel. Simulate Alice observing it.
  sent.length = 0;
  await alice.bus.services.channels.ensureFromObservedMessage({
    groupId,
    channelId: "design",
    senderAccountId: BOB,
  });

  // Alice should have created the channel locally AND sent a sync request to Bob.
  const aliceChannels = await alice.bus.stores.channelStore.listChannels({
    ownerAccountId: ALICE, groupId,
  });
  const haveDesign = aliceChannels.some((c) => c.channelId === "design");
  assert.equal(haveDesign, true, "channel materialized locally");

  assert.equal(sent.length, 1, "exactly one sync_request fanned out");
  const decoded = JSON.parse(Buffer.from(sent[0].plaintextBodyBytes).toString("utf8"));
  assert.equal(decoded.op, "channels.sync_request", "op is channels.sync_request");
  assert.equal(decoded.groupId, groupId, "sync_request carries groupId");
  assert.equal(sent[0].peerAccountId, BOB, "sync_request targets the sender");
});

test("ensureFromObservedMessage does NOT send sync_request when channel already known", async () => {
  let now = 1000;
  const sent = [];
  const storage = new TestStorageProvider();
  const alice = makeServer({ ownerAccountId: ALICE, storage, sendCapture: sent, clock: () => (now += 1) });

  const created = await alice.bus.services.groups.createGroup({ title: "Crew" });
  const groupId = created.groupId;
  await alice.bus.stores.groupStore.ensureMembership({
    ownerAccountId: ALICE, groupId, accountId: BOB, role: "member",
  });
  await alice.bus.services.channels.createChannel({ groupId, channelId: "design" });

  sent.length = 0;
  await alice.bus.services.channels.ensureFromObservedMessage({
    groupId,
    channelId: "design",
    senderAccountId: BOB,
  });

  assert.equal(sent.length, 0, "no sync_request when channel already known");
});

test("fanoutChannelsToPeer omits tombstoned channels", async () => {
  let now = 1000;
  const sent = [];
  const aliceStorage = new TestStorageProvider();
  const alice = makeServer({ ownerAccountId: ALICE, storage: aliceStorage, sendCapture: sent, clock: () => (now += 1) });

  const created = await alice.bus.services.groups.createGroup({ title: "Crew" });
  const groupId = created.groupId;
  await alice.bus.stores.groupStore.ensureMembership({
    ownerAccountId: ALICE, groupId, accountId: BOB, role: "member",
  });
  await alice.bus.services.channels.createChannel({ groupId, channelId: "dev" });
  await alice.bus.services.channels.createChannel({ groupId, channelId: "stale" });
  await alice.bus.services.channels.deleteChannel({ groupId, channelId: "stale" });

  sent.length = 0;
  await alice.bus.services.channels.fanoutChannelsToPeer({ groupId, peerAccountId: BOB });

  assert.equal(sent.length, 1, "only active channel re-sent");
  const decoded = JSON.parse(Buffer.from(sent[0].plaintextBodyBytes).toString("utf8"));
  assert.equal(decoded.channelId, "dev");
});
