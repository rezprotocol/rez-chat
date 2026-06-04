import test from "node:test";
import assert from "node:assert/strict";
import { ChatServerApp } from "../src/server/app/ChatServerApp.js";
import { GroupStore } from "../src/server/storage/ChatGroupStore.js";
import { makeSealDispatch } from "./support/sealDispatchDouble.js";

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
  getObjectStore() { return { deposit: async () => ({}), list: async () => [] }; }
  getMailboxStore() { return { deposit: async () => ({}), poll: async () => [] }; }
}

const FAKE_IDENTITY = {
  accountId: "rez:acct:test-owner",
  publicKeyB64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  privateKeyB64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
};

const OWNER = "rez:acct:test-owner";
const SENDER = "rez:acct:sender-1";
const GROUP_ID = "grp_sync_test";

function createServer(storage) {
  return new ChatServerApp({
    identity: FAKE_IDENTITY,
    uplinks: ["ws://localhost:9999"],
    storageProvider: storage,
    ownerAccountId: OWNER,
    clock: () => 2000,
    sdk: {
      ...makeSealDispatch(),
      getIdentity: () => ({ localInboxId: "inbox:test-owner" }),
    },
  });
}

test("inbound group message ensures sender membership", async () => {
  const storage = new TestStorageProvider();
  const groupStore = new GroupStore({ storageProvider: storage, clock: () => 1000 });
  await groupStore.ensureGroup({
    ownerAccountId: OWNER,
    groupId: GROUP_ID,
    createdBy: OWNER,
    title: "Sync Test",
  });
  await groupStore.ensureMembership({
    ownerAccountId: OWNER,
    groupId: GROUP_ID,
    accountId: OWNER,
    role: "admin",
  });

  const server = createServer(storage);
  const threadId = server.bus.services.threads.groupThreadId(GROUP_ID);

  // Create group thread
  await server.bus.stores.threadStore.ensureThread({
    threadId,
    groupId: GROUP_ID,
    threadType: "group",
    peerAccountId: null,
    title: "Sync Test",
  });

  // Create a mock SDK that lets us fire the mailbox deposited event
  const handlers = {};
  const mockSdk = {
    subscriptions: {
      onPeerLinkUpdated: (fn) => { handlers.peerLink = fn; return () => {}; },
      onMailboxDeposited: (fn) => { handlers.mailbox = fn; return () => {}; },
      onDeliveryAck: (fn) => { handlers.ack = fn; return () => {}; },
    },
  };
  server.bus.runtime = { sdk: mockSdk };

  // Start the event service so it subscribes
  await server.bus.services.events.start();

  // Simulate inbound group message with senderAccountId in the payload
  const payload = { kind: "text", text: "hello group", senderAccountId: SENDER, threadId };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64");

  await handlers.mailbox({
    body: {
      eventId: "evt-sync-1",
      mailboxId: "inbox:test",
      ciphertextB64: payloadB64,
    },
  });

  // Verify sender was added as member
  const membership = await server.bus.stores.groupStore.getMembership({
    ownerAccountId: OWNER,
    groupId: GROUP_ID,
    accountId: SENDER,
  });
  assert.ok(membership, "sender should have a membership record");
  assert.equal(membership.state, "active");
  assert.equal(membership.accountId, SENDER);
});

test("inbound DM does not trigger group membership sync", async () => {
  const storage = new TestStorageProvider();
  const server = createServer(storage);

  // Create a DM thread
  const threadKv = storage.getKeyValueStore(OWNER);
  await threadKv.set("app:threads/" + OWNER + "/th_dm_sync", {
    threadId: "th_dm_sync",
    threadType: "direct",
    peerAccountId: SENDER,
    createdAtMs: 1000,
    updatedAtMs: 1000,
  });

  const handlers = {};
  const mockSdk = {
    subscriptions: {
      onPeerLinkUpdated: (fn) => { handlers.peerLink = fn; return () => {}; },
      onMailboxDeposited: (fn) => { handlers.mailbox = fn; return () => {}; },
      onDeliveryAck: (fn) => { handlers.ack = fn; return () => {}; },
    },
  };
  server.bus.runtime = { sdk: mockSdk };
  await server.bus.services.events.start();

  const payload = { kind: "text", text: "hello dm", senderAccountId: SENDER, threadId: "th_dm_sync" };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64");

  await handlers.mailbox({
    body: {
      eventId: "evt-dm-1",
      mailboxId: "inbox:test",
      ciphertextB64: payloadB64,
    },
  });

  // No group membership should be created for DMs
  // (No groupStore entries besides the default empty store)
  const groupStore = new GroupStore({ storageProvider: storage, clock: () => 1000 });
  const members = await groupStore.listMembers({
    ownerAccountId: OWNER,
    groupId: GROUP_ID,
  });
  assert.equal(members.length, 0, "DM should not create group membership");
});

test("inbound DM with sender-local thread id resolves to local direct thread", async () => {
  const storage = new TestStorageProvider();
  const server = createServer(storage);
  const localThreadId = "th_dm_local_receiver";
  const remoteThreadId = "th_dm_remote_sender";

  await server.bus.stores.threadStore.ensureThread({
    threadId: localThreadId,
    threadType: "direct",
    peerAccountId: SENDER,
    peerInboxId: "inbox:sender",
    createdAtMs: 1000,
  });

  const handlers = {};
  const mockSdk = {
    subscriptions: {
      onPeerLinkUpdated: (fn) => { handlers.peerLink = fn; return () => {}; },
      onMailboxDeposited: (fn) => { handlers.mailbox = fn; return () => {}; },
      onDeliveryAck: (fn) => { handlers.ack = fn; return () => {}; },
    },
  };
  server.bus.runtime = { sdk: mockSdk };
  await server.bus.services.events.start();

  const payload = {
    kind: "text",
    text: "hello from remote-local thread",
    senderAccountId: SENDER,
    threadId: remoteThreadId,
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64");

  await handlers.mailbox({
    body: {
      eventId: "evt-dm-foreign-thread",
      mailboxId: "inbox:test",
      ciphertextB64: payloadB64,
    },
  });

  const localMessages = await server.bus.stores.threadStore.listMessages({
    threadId: localThreadId,
    limit: 50,
  });
  assert.equal(localMessages.items.length, 1);
  assert.equal(localMessages.items[0].text, "hello from remote-local thread");
  assert.equal(localMessages.items[0].senderAccountId, SENDER);

  const remoteMessages = await server.bus.stores.threadStore.listMessages({
    threadId: remoteThreadId,
    limit: 50,
  });
  assert.equal(remoteMessages.items.length, 0);
});
