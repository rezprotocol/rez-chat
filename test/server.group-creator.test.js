// SECURITY (audit pass 5, Part A): the group CREATOR (group.createdBy) is the
// immutable anchor of authority. A promoted admin must not be able to kick or
// demote the founder and take over the group. Protection is enforced on BOTH
// the action side (the would-be attacker's own node) AND the inbound-op side
// (every receiving node, keyed on its own createdBy).

import test from "node:test";
import assert from "node:assert/strict";

import { ChatServerApp } from "../src/server/app/ChatServerApp.js";
import { GroupOpPayloadV1 } from "../src/records/payloads/GroupOpPayloadV1.js";
import { makeSealDispatch } from "./support/sealDispatchDouble.js";
import { permissiveAccountAuthority } from "./support/memberConsentDouble.js";

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
}
const FAKE_KEYS = {
  publicKeyB64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  privateKeyB64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
};

const ALICE = "rez:acct:alice"; // the creator / founder
const BOB = "rez:acct:bob";     // a promoted admin (the would-be usurper)
const CAROL = "rez:acct:carol"; // another member

function makeServer(ownerAccountId) {
  const app = new ChatServerApp({
    identity: { ...FAKE_KEYS, accountId: ownerAccountId, deviceId: "dev:" + ownerAccountId },
    uplinks: ["ws://localhost:9999"],
    storageProvider: new TestStorageProvider(),
    ownerAccountId,
    clock: () => Date.now(),
  });
  app.bus.runtime.sdk = {
    ...makeSealDispatch(),
    getIdentity: () => ({ localInboxId: "inbox:" + ownerAccountId }),
  };
  return app;
}

// Seed a group on `app`'s node: founded by ALICE (creator), with the given
// extra members. `ownerRole` is the local owner's role in the group.
async function seed(app, { groupId, members }) {
  await app.bus.stores.groupStore.ensureGroup({
    ownerAccountId: app.ownerAccountId, groupId, createdBy: ALICE, title: "G",
  });
  await app.bus.stores.groupStore.ensureMembership({
    ownerAccountId: app.ownerAccountId, groupId, accountId: ALICE, role: "creator",
  });
  for (const [accountId, role] of members) {
    await app.bus.stores.groupStore.ensureMembership({
      ownerAccountId: app.ownerAccountId, groupId, accountId, role,
    });
  }
}

test("action: an admin cannot kick the group creator", async () => {
  const groupId = "grp_kick_creator";
  const app = makeServer(BOB); // Bob (admin) attempts the kick
  await seed(app, { groupId, members: [[BOB, "admin"]] });

  await assert.rejects(
    app.bus.services.groups.kickMember({ groupId, accountId: ALICE }),
    /creator cannot be removed/,
    "kicking the creator is refused at the source",
  );
  const alice = await app.bus.stores.groupStore.getMembership({
    ownerAccountId: BOB, groupId, accountId: ALICE,
  });
  assert.equal(alice.state, "active", "creator remains active");
});

test("action: an admin cannot demote the creator", async () => {
  const groupId = "grp_demote_creator";
  const app = makeServer(BOB);
  await seed(app, { groupId, members: [[BOB, "admin"]] });

  await assert.rejects(
    app.bus.services.groups.setMemberRole({ groupId, accountId: ALICE, role: "member" }),
    /creator's role cannot be changed/,
    "demoting the creator is refused",
  );
  const alice = await app.bus.stores.groupStore.getMembership({
    ownerAccountId: BOB, groupId, accountId: ALICE,
  });
  assert.equal(String(alice.role).toLowerCase(), "creator", "creator role intact");
});

test("the 'creator' role can never be assigned to a non-founder", async () => {
  const groupId = "grp_no_mint";
  const app = makeServer(CAROL);
  await seed(app, { groupId, members: [[BOB, "admin"], [CAROL, "member"]] });

  // An inbound op trying to make Bob a creator. Defense is layered: the payload
  // schema may reject role="creator" outright, and #applyIncomingSetRole drops
  // it regardless. Either way Bob never becomes a creator.
  let op = null;
  try {
    op = new GroupOpPayloadV1({
      op: "setRole", groupId, accountId: BOB, role: "creator",
      actedAtMs: Date.now(), groupOpId: "gop_mint",
    });
  } catch (err) { op = null; }
  if (op) {
    await app.bus.services.groups.handleIncomingGroupOp(op, { senderAccountId: BOB });
  }
  const bob = await app.bus.stores.groupStore.getMembership({
    ownerAccountId: CAROL, groupId, accountId: BOB,
  });
  assert.notEqual(String(bob.role).toLowerCase(), "creator",
    "a second creator can never be minted");
});

test("inbound: a kick op targeting the creator is ignored on every node (takeover blocked)", async () => {
  const groupId = "grp_inbound_kick";
  const app = makeServer(CAROL); // Carol receives Bob's malicious op
  await seed(app, { groupId, members: [[BOB, "admin"], [CAROL, "member"]] });

  // Bob (an active admin) crafts a kick op for Alice, the creator.
  await app.bus.services.groups.handleIncomingGroupOp(new GroupOpPayloadV1({
    op: "kick", groupId, accountId: ALICE, actedAtMs: Date.now(), groupOpId: "gop_evil_kick",
  }), { senderAccountId: BOB });

  const alice = await app.bus.stores.groupStore.getMembership({
    ownerAccountId: CAROL, groupId, accountId: ALICE,
  });
  assert.equal(alice.state, "active",
    "creator is NOT removed by an inbound kick — the takeover is blocked authoritatively");
});

test("inbound: a setRole op demoting the creator is ignored on every node", async () => {
  const groupId = "grp_inbound_demote";
  const app = makeServer(CAROL);
  await seed(app, { groupId, members: [[BOB, "admin"], [CAROL, "member"]] });

  await app.bus.services.groups.handleIncomingGroupOp(new GroupOpPayloadV1({
    op: "setRole", groupId, accountId: ALICE, role: "member",
    actedAtMs: Date.now(), groupOpId: "gop_evil_demote",
  }), { senderAccountId: BOB });

  const alice = await app.bus.stores.groupStore.getMembership({
    ownerAccountId: CAROL, groupId, accountId: ALICE,
  });
  assert.equal(String(alice.role).toLowerCase(), "creator",
    "creator keeps the creator role despite an inbound demote op");
});

test("the founder is surfaced as 'creator' in the member list", async () => {
  const groupId = "grp_member_list";
  const app = makeServer(ALICE);
  await seed(app, { groupId, members: [[BOB, "admin"]] });

  const result = await app.bus.services.groups.listGroupMembers({ groupId });
  const aliceRow = result.items.find((m) => m.accountId === ALICE);
  assert.ok(aliceRow, "creator present in member list");
  assert.equal(String(aliceRow.role).toLowerCase(), "creator",
    "founder is shown as the creator");
});

test("createGroup names the founder's own row at creation + emits (no reliance on first invite)", async () => {
  // Regression: createGroup left the creator membership nameless, relying on a
  // LATER createInvite -> ensureSelfMembershipProof to fill the name (which also
  // didn't emit). The founder saw their own bare account id until they invited
  // someone. Make the name explicit + verifiable + emitted at creation.
  const app = makeServer(ALICE);
  app.bus.runtime.accountAuthority = permissiveAccountAuthority();
  const emitted = [];
  app.bus.on("group.members.updated", (e) => emitted.push(e));

  const { groupId } = await app.bus.services.groups.createGroup({ title: "G", creatorDisplayName: "Alice" });

  const alice = await app.bus.stores.groupStore.getMembership({ ownerAccountId: ALICE, groupId, accountId: ALICE });
  assert.equal(alice.displayName, "Alice", "founder named on their membership row at creation");
  assert.ok(alice.joinerSigB64, "founder self consent-proof signed at creation (verifiable name)");
  assert.ok(emitted.some((e) => e.groupId === groupId), "members.updated emitted so the founder's roster refreshes");
});

test("createGroup without a creatorDisplayName still succeeds (graceful degrade, no proof, no throw)", async () => {
  const app = makeServer(ALICE);
  const { groupId } = await app.bus.services.groups.createGroup({ title: "G" });
  const alice = await app.bus.stores.groupStore.getMembership({ ownerAccountId: ALICE, groupId, accountId: ALICE });
  assert.equal(String(alice.role).toLowerCase(), "creator", "creator row created even without a name");
});
