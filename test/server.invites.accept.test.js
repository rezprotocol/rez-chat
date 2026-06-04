import test from "node:test";
import assert from "node:assert/strict";

import { ChatServerApp } from "../src/server/app/ChatServerApp.js";
import {
  encodeInviteCodeV3,
  MeshCapability,
  PEERLINK_INVITE_RECORD_KIND,
} from "@rezprotocol/sdk/client";

// A realistic DER-SPKI Ed25519 base64 key (contains + / =) — the invite code
// commits to it and the inner envelope must be signed by the same identity.
const INVITER_PUB = "MCowBQYDK2VwAyEA2crNvu+ZeiFMoMNP/imhLa/HIyYg6x96US6AyOqijPg=";

// Encode {envelope, signatureB64} the way PeerLinkService.createInvite does so
// _fetchDurableInviteEnvelope can decode it back out of the durable record.
function makeDurableRecord({ inviteId, envelope, signatureB64 = "sig" }) {
  const payloadB64 = Buffer.from(
    JSON.stringify({ envelope, signatureB64 }),
  ).toString("base64");
  return {
    v: 1,
    recordKind: PEERLINK_INVITE_RECORD_KIND,
    recordId: inviteId,
    publisherPublicKeyB64: INVITER_PUB,
    payloadB64,
  };
}

// Minimal in-memory stand-in for sdk.durableRecords: put stores by recordId,
// get returns it. Lets accept() resolve the envelope with no live inviter.
function makeDurableRecordStore() {
  const byId = new Map();
  return {
    store: byId,
    put: async ({ record }) => { byId.set(record.recordId, record); },
    get: async ({ recordId }) => byId.get(recordId) || null,
  };
}

class TestKVStore {
  constructor() {
    this._data = new Map();
  }

  async get(key) {
    return this._data.get(key);
  }

  async set(key, value) {
    this._data.set(key, value);
  }

  async delete(key) {
    this._data.delete(key);
  }

  async keys(prefix) {
    const out = [];
    for (const key of this._data.keys()) {
      if (String(key).startsWith(prefix)) out.push(key);
    }
    return out;
  }
}

class TestStorageProvider {
  constructor() {
    this._stores = new Map();
  }

  getKeyValueStore(name) {
    const key = String(name || "default");
    if (!this._stores.has(key)) {
      this._stores.set(key, new TestKVStore());
    }
    return this._stores.get(key);
  }
}

const FAKE_IDENTITY = {
  accountId: "rez:acct:bob",
  publicKeyB64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  privateKeyB64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
};

function createServer({ sdk, peerLinks, clock = () => 1000 } = {}) {
  const app = new ChatServerApp({
    identity: FAKE_IDENTITY,
    uplinks: ["ws://localhost:9999"],
    storageProvider: new TestStorageProvider(),
    ownerAccountId: "rez:acct:bob",
    clock,
  });
  app.bus.runtime.sdk = sdk;
  app.bus.runtime.peerLinks = peerLinks;
  return app;
}

test("invite.accept materializes a ready direct thread and sidebar index row", async () => {
  let now = 1000;
  const snapshot = {
    peerLinkId: "pl_accept_1",
    state: "handshake_sent",
    sessionState: "pending_remote_confirm",
    localAccountId: "rez:acct:bob",
    peerAccountId: "rez:acct:alice",
    peerInboxId: "inbox:alice",
  };

  // Fake local PeerLinkService — the inviter is OFFLINE, so there is no
  // locally stored invite (getStoredInviteEnvelope → null) and the envelope
  // must be resolved from the durable-record store. The envelope is signed by
  // the same identity the v3 code commits to (signerRef.signerPublicKeyB64).
  const inviteId = "plinv_test";
  const directEnvelope = {
    creatorDisplayName: "Alice",
    signerRef: { signerPublicKeyB64: INVITER_PUB },
  };
  const fakePeerLinks = {
    ownerAccountId: "rez:acct:bob",
    getStoredInviteEnvelope: async () => null,
    acceptInvite: async () => ({ snapshot, event: null }),
  };

  const durableRecords = makeDurableRecordStore();
  await durableRecords.put({ record: makeDurableRecord({ inviteId, envelope: directEnvelope }) });

  const server = createServer({
    clock: () => { now += 1; return now; },
    sdk: {
      getIdentity: () => ({ localInboxId: "inbox:bob" }),
      mailbox: { deposit: async () => ({ eventId: "evt-1" }) },
      peerLinks: { getPeerLink: async () => snapshot },
      durableRecords,
    },
    peerLinks: fakePeerLinks,
  });

  const events = [];
  server.bus.on("thread.index.updated", (record) => {
    events.push(record);
  });

  const inviteCode = encodeInviteCodeV3({ inviteId, publisherPublicKeyB64: INVITER_PUB });

  const accepted = await server.bus.call("invite", "accept", {
    inviteCode,
    acceptorDisplayName: "Bob",
  });

  assert.equal(accepted.peerAccountId, "rez:acct:alice");
  assert.equal(accepted.peerInboxId, "inbox:alice");
  assert.equal(typeof accepted.threadId, "string");
  assert.equal(accepted.threadId.length > 0, true);

  const listed = await server.bus.call("threads", "list", { limit: 10 });
  assert.equal(listed.threads.length, 1);
  assert.equal(listed.threads[0].threadId, accepted.threadId);
  assert.equal(listed.threads[0].peerAccountId, "rez:acct:alice");
  assert.equal(listed.threads[0].peerInboxId, "inbox:alice");
  assert.equal(listed.threads[0].threadReady, true);
  assert.equal(listed.threads[0].sendAllowed, true);
  assert.equal(events.some((record) => record.threadId === accepted.threadId), true);
});

test("invite.create forwards title; invite.accept materializes the group with that title", async () => {
  let now = 1000;
  const inviteCreateCalls = [];
  const groupId = "grp_test_envelope_title";
  const groupSnapshot = {
    peerLinkId: "pl_grp_1",
    state: "handshake_sent",
    sessionState: "pending_remote_confirm",
    localAccountId: "rez:acct:bob",
    peerAccountId: "rez:acct:alice",
    peerInboxId: "inbox:alice",
    groupId,
  };

  // The fake PeerLinkService records what createInvite was called with and
  // publishes the signed envelope (with the group title) as a durable record.
  // The acceptor — with the inviter OFFLINE — resolves that same record from
  // the durable store, so this verifies the full title round-trip end-to-end
  // through the publish→fetch path of ServerInvitesService.
  const inviteId = "plinv_grouped";
  const groupEnvelope = {
    creatorDisplayName: "Alice",
    title: "Secret Group",
    groupId,
    inviteId,
    signerRef: { signerPublicKeyB64: INVITER_PUB },
  };
  const fakePeerLinks = {
    ownerAccountId: "rez:acct:bob",
    createInvite: async (opts) => {
      inviteCreateCalls.push(opts);
      return {
        peerLinkId: "pl_grp_1",
        inviteId,
        state: "active",
        expiresAtMs: now + 86400000,
        maxUses: 1,
        publisherPublicKeyB64: INVITER_PUB,
        durableRecord: makeDurableRecord({ inviteId, envelope: groupEnvelope }),
      };
    },
    getStoredInviteEnvelope: async () => null,
    acceptInvite: async () => ({ snapshot: groupSnapshot, event: null }),
  };

  const durableRecords = makeDurableRecordStore();
  const mailbox = { deposit: async () => ({ eventId: "evt-1" }) };
  const server = createServer({
    clock: () => { now += 1; return now; },
    sdk: {
      getIdentity: () => ({ localInboxId: "inbox:bob" }),
      mailbox,
      peerLinks: { getPeerLink: async () => groupSnapshot },
      durableRecords,
      // createInvite now publishes via the real mesh-dispatch verb. Wire a real
      // MeshCapability over the stub store so dispatch routing + the coordinate
      // guard are genuinely exercised — only the leaf store is a stand-in.
      mesh: new MeshCapability({ pool: null, mailbox, durableRecords }),
    },
    peerLinks: fakePeerLinks,
  });
  // ServerInvitesService.createInvite requires an inboxClaimant to mint the
  // post-cap; stub a minimal one so we can drive invite creation in tests.
  server.bus.runtime.inboxClaimant = { inboxId: "inbox:bob" };

  // Only an active member may mint a group invite (H2). Seed Bob as the
  // founder of the group — the realistic create-group-then-invite flow.
  await server.bus.stores.groupStore.ensureGroup({
    ownerAccountId: "rez:acct:bob", groupId, createdBy: "rez:acct:bob", title: "Secret Group",
  });
  await server.bus.stores.groupStore.ensureMembership({
    ownerAccountId: "rez:acct:bob", groupId, accountId: "rez:acct:bob", role: "admin",
  });

  // 1. CREATE side: title flows through the directive into the SDK envelope.
  await server.bus.call("invite", "create", {
    kind: "group",
    groupId,
    maxUses: 1,
    creatorDisplayName: "Bob",
    title: "Secret Group",
  });
  assert.equal(inviteCreateCalls.length, 1, "createInvite called once");
  assert.equal(inviteCreateCalls[0].title, "Secret Group",
    "title forwarded to PeerLinkService.createInvite");
  assert.equal(inviteCreateCalls[0].kind, "group");
  assert.equal(inviteCreateCalls[0].groupId, groupId);
  // The signed envelope was published to the durable store at create time.
  assert.equal(durableRecords.store.has(inviteId), true,
    "createInvite publishes the durable invite record");

  // 2. ACCEPT side: the title in the envelope is used to ensureGroupThread.
  const inviteCode = encodeInviteCodeV3({ inviteId, publisherPublicKeyB64: INVITER_PUB });
  const accepted = await server.bus.call("invite", "accept", {
    inviteCode,
    acceptorDisplayName: "Bob",
  });
  assert.equal(accepted.groupId, groupId, "accept returns groupId");

  // Group should be materialized locally with the title from the envelope.
  const stored = await server.bus.stores.groupStore.getGroup({
    ownerAccountId: "rez:acct:bob",
    groupId,
  });
  assert.ok(stored, "group materialized on acceptor side");
  assert.equal(stored.title, "Secret Group",
    "group.title populated from envelope on acceptor side");

  // The group thread should also carry the title (so the sidebar row
  // resolves it before any group.updated event fires).
  const groupThreadId = server.bus.services.threads.groupThreadId(groupId);
  const groupThread = await server.bus.stores.threadStore.getThread(groupThreadId);
  assert.ok(groupThread, "group thread materialized");
  assert.equal(groupThread.title, "Secret Group",
    "thread.title populated from envelope title");
});

// --- H2: true founder + invite-create membership gate ----------------------

function makeAcceptServer({ groupSnapshot, durableRecords }) {
  const fakePeerLinks = {
    ownerAccountId: "rez:acct:bob",
    getStoredInviteEnvelope: async () => null,
    acceptInvite: async () => ({ snapshot: groupSnapshot, event: null }),
  };
  const server = createServer({
    sdk: {
      getIdentity: () => ({ localInboxId: "inbox:bob" }),
      mailbox: { deposit: async () => ({}) },
      peerLinks: { getPeerLink: async () => groupSnapshot },
      durableRecords,
    },
    peerLinks: fakePeerLinks,
  });
  server.bus.runtime.inboxClaimant = { inboxId: "inbox:bob" };
  return server;
}

test("H2: invite.accept stamps the TRUE founder (verified against the groupId), not the inviter", async () => {
  const inviteId = "plinv_h2_founder";
  const FOUNDER = "rez:acct:founder"; // real founder, carried + bound in the envelope
  const INVITER = "rez:acct:alice";   // a member who invited us — NOT the founder
  const salt = "1717000000000:abcd-efgh";
  const durableRecords = makeDurableRecordStore();
  // Server first, so we can derive a groupId that actually binds to FOUNDER+salt.
  const server = makeAcceptServer({ groupSnapshot: { groupId: "placeholder" }, durableRecords });
  const groupId = server.bus.services.threads.groupIdForCreator(FOUNDER, salt);

  const groupSnapshot = {
    peerLinkId: "pl_h2", state: "handshake_sent", sessionState: "pending_remote_confirm",
    localAccountId: "rez:acct:bob", peerAccountId: INVITER, peerInboxId: "inbox:alice", groupId,
  };
  const realServer = makeAcceptServer({ groupSnapshot, durableRecords });
  const groupEnvelope = {
    creatorDisplayName: "Alice", title: "Founded Group", groupId,
    groupCreatedBy: FOUNDER, groupSalt: salt, inviteId,
    signerRef: { signerPublicKeyB64: INVITER_PUB },
  };
  await durableRecords.put({ record: makeDurableRecord({ inviteId, envelope: groupEnvelope }) });

  const code = encodeInviteCodeV3({ inviteId, publisherPublicKeyB64: INVITER_PUB });
  await realServer.bus.call("invite", "accept", { inviteCode: code, acceptorDisplayName: "Bob" });

  const stored = await realServer.bus.stores.groupStore.getGroup({ ownerAccountId: "rez:acct:bob", groupId });
  assert.ok(stored, "group materialized on accept");
  assert.equal(stored.createdBy, FOUNDER, "createdBy is the verified true founder");
  assert.notEqual(stored.createdBy, INVITER, "the inviter is NOT stamped as founder");
  assert.equal(stored.creatorSalt, salt, "verified salt stored for re-propagation");
});

test("H2: a FORGED founder binding (inviter self-stamps as creator) is rejected", async () => {
  const inviteId = "plinv_h2_forge";
  const REAL_FOUNDER = "rez:acct:founder";
  const ATTACKER = "rez:acct:alice"; // the inviter, trying to claim creator-ship
  const salt = "1717000000000:zzzz";
  const durableRecords = makeDurableRecordStore();
  const server0 = makeAcceptServer({ groupSnapshot: { groupId: "x" }, durableRecords });
  // The REAL groupId is bound to REAL_FOUNDER, not the attacker.
  const groupId = server0.bus.services.threads.groupIdForCreator(REAL_FOUNDER, salt);

  const groupSnapshot = {
    peerLinkId: "pl_forge", state: "handshake_sent", sessionState: "pending_remote_confirm",
    localAccountId: "rez:acct:bob", peerAccountId: ATTACKER, peerInboxId: "inbox:alice", groupId,
  };
  const server = makeAcceptServer({ groupSnapshot, durableRecords });
  // Attacker claims THEMSELVES as creator but cannot produce a salt binding
  // their id to the real groupId.
  const forgedEnvelope = {
    creatorDisplayName: "Alice", title: "Hijacked", groupId,
    groupCreatedBy: ATTACKER, groupSalt: salt, inviteId,
    signerRef: { signerPublicKeyB64: INVITER_PUB },
  };
  await durableRecords.put({ record: makeDurableRecord({ inviteId, envelope: forgedEnvelope }) });

  const code = encodeInviteCodeV3({ inviteId, publisherPublicKeyB64: INVITER_PUB });
  await assert.rejects(
    server.bus.call("invite", "accept", { inviteCode: code, acceptorDisplayName: "Bob" }),
    /binding failed/,
    "a forged founder claim is rejected (cannot self-stamp as creator)",
  );
  const stored = await server.bus.stores.groupStore.getGroup({ ownerAccountId: "rez:acct:bob", groupId });
  assert.ok(!stored, "no group materialized from a forged invite");
});

test("H2: invite.create for a group is rejected when the creator is not an active member", async () => {
  const fakePeerLinks = {
    ownerAccountId: "rez:acct:bob",
    createInvite: async () => { throw new Error("createInvite should not be reached"); },
  };
  const server = createServer({
    sdk: { getIdentity: () => ({ localInboxId: "inbox:bob" }), durableRecords: makeDurableRecordStore() },
    peerLinks: fakePeerLinks,
  });
  server.bus.runtime.inboxClaimant = { inboxId: "inbox:bob" };

  // Bob is NOT a member of grp_outsider — minting an invite must be refused.
  await assert.rejects(
    server.bus.call("invite", "create", { kind: "group", groupId: "grp_outsider", maxUses: 1 }),
    /only an active member can invite to a group/,
    "a non-member cannot mint a group invite",
  );
});
