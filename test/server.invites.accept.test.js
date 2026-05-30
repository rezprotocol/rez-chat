import test from "node:test";
import assert from "node:assert/strict";

import { ChatServerApp } from "../src/server/app/ChatServerApp.js";

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

  // Fake local PeerLinkService — returns stored envelope on lookup, accepts
  // the invite and returns the expected snapshot. ServerInvitesService now
  // uses bus.runtime.peerLinks directly (Shape A).
  const directEnvelope = {
    envelope: { creatorDisplayName: "Alice" },
    signatureB64: "sig",
  };
  const fakePeerLinks = {
    ownerAccountId: "rez:acct:bob",
    getStoredInviteEnvelope: async () => directEnvelope,
    claimInviteAsRemote: async () => directEnvelope,
    acceptInvite: async () => ({ snapshot, event: null }),
  };

  const server = createServer({
    clock: () => { now += 1; return now; },
    sdk: {
      getIdentity: () => ({ localInboxId: "inbox:bob" }),
      mailbox: { deposit: async () => ({ eventId: "evt-1" }) },
      peerLinks: { getPeerLink: async () => snapshot },
    },
    peerLinks: fakePeerLinks,
  });

  const events = [];
  server.bus.on("thread.index.updated", (record) => {
    events.push(record);
  });

  // Use a real v2 invite-code shape so parseInviteCodeV2 accepts it.
  const inviteCode = "rez:inv:v2:plinv_test.inbox:alice";

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
  // replays it back via getStoredInviteEnvelope on the acceptor path, so we
  // can verify the full title round-trip end-to-end through ServerInvitesService.
  const groupEnvelope = {
    envelope: {
      creatorDisplayName: "Alice",
      title: "Secret Group",
      groupId,
    },
    signatureB64: "sig",
  };
  const fakePeerLinks = {
    ownerAccountId: "rez:acct:bob",
    createInvite: async (opts) => {
      inviteCreateCalls.push(opts);
      return {
        peerLinkId: "pl_grp_1",
        inviteId: "plinv_grouped",
        state: "active",
        expiresAtMs: now + 86400000,
        maxUses: 1,
      };
    },
    getStoredInviteEnvelope: async () => groupEnvelope,
    claimInviteAsRemote: async () => groupEnvelope,
    acceptInvite: async () => ({ snapshot: groupSnapshot, event: null }),
  };

  const server = createServer({
    clock: () => { now += 1; return now; },
    sdk: {
      getIdentity: () => ({ localInboxId: "inbox:bob" }),
      mailbox: { deposit: async () => ({ eventId: "evt-1" }) },
      peerLinks: { getPeerLink: async () => groupSnapshot },
    },
    peerLinks: fakePeerLinks,
  });
  // ServerInvitesService.createInvite requires an inboxClaimant to mint the
  // post-cap; stub a minimal one so we can drive invite creation in tests.
  server.bus.runtime.inboxClaimant = { inboxId: "inbox:bob" };

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

  // 2. ACCEPT side: the title in the envelope is used to ensureGroupThread.
  const inviteCode = "rez:inv:v2:plinv_grouped.inbox:alice";
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
