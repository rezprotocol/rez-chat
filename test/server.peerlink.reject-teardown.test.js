import test from "node:test";
import assert from "node:assert/strict";

import { ServerEventService } from "../src/server/services/ServerEventService.js";

// Minimal bus: synchronous emit (matches ChatServerBus), plus the service
// surface ServerEventService.start() subscribes against.
function makeBus() {
  const handlers = new Map();
  return {
    runtime: {},
    services: {},
    stores: {},
    on(name, fn) {
      if (!handlers.has(name)) handlers.set(name, new Set());
      handlers.get(name).add(fn);
      return () => handlers.get(name).delete(fn);
    },
    emit(name, payload) {
      const hs = handlers.get(name);
      if (!hs) return;
      for (const h of [...hs]) h(payload);
    },
    registerFunction() {},
    call() { return Promise.resolve(null); },
  };
}

// Async event handlers aren't awaited by emit; flush the microtask/macrotask
// queue so the handler's awaited store calls complete before asserting.
function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function setupService() {
  const bus = makeBus();
  const deletedThreads = [];
  const deletedContacts = [];
  const discardedInvites = [];
  bus.services.threads = {
    directThreadIdForPeerLink: (peerLinkId, peerAccountId) => "th_direct_" + peerLinkId + "_" + peerAccountId,
    deleteThread: async ({ threadId }) => { deletedThreads.push(threadId); return { deleted: true }; },
  };
  bus.services.contacts = {
    deleteContact: async ({ accountId }) => { deletedContacts.push(accountId); return { deleted: true }; },
  };
  bus.services.groups = {
    discardGroupForRejectedInvite: async ({ inviteId }) => {
      discardedInvites.push(inviteId);
      return { removed: [] };
    },
  };
  const svc = new ServerEventService({ bus, ownerAccountId: "rez:acct:me", clock: () => 1000 });
  return { bus, svc, deletedThreads, deletedContacts, discardedInvites };
}

test("rejected peer-link snapshot tears down direct thread + contact + the one invite's group", async () => {
  const { bus, svc, deletedThreads, deletedContacts, discardedInvites } = setupService();
  await svc.start();

  bus.emit("peerlink.protocol.snapshot", {
    state: "rejected",
    peerLinkId: "pl_rej",
    peerAccountId: "rez:acct:inviter",
    peerInboxId: "inbox:inviter",
    activeInviteId: "plinv_rejected",
  });
  await flush();

  assert.deepEqual(deletedThreads, ["th_direct_pl_rej_rez:acct:inviter"],
    "optimistic direct thread deleted on reject");
  assert.deepEqual(deletedContacts, ["rez:acct:inviter"],
    "optimistic contact deleted on reject (full teardown)");
  assert.deepEqual(discardedInvites, ["plinv_rejected"],
    "only the group joined via the rejected invite is discarded (bound to the one invite)");
});

test("rejected snapshot without an activeInviteId does not attempt group teardown", async () => {
  const { bus, svc, discardedInvites } = setupService();
  await svc.start();

  bus.emit("peerlink.protocol.snapshot", {
    state: "rejected",
    peerLinkId: "pl_rej_dm",
    peerAccountId: "rez:acct:inviter",
    peerInboxId: "inbox:inviter",
    activeInviteId: null,
  });
  await flush();

  assert.equal(discardedInvites.length, 0, "no group teardown when there is no invite id (pure DM reject)");
});

test("non-rejected snapshots do NOT trigger teardown", async () => {
  const { bus, svc, deletedThreads, deletedContacts } = setupService();
  await svc.start();

  // A non-terminal in-flight state must never delete optimistic state.
  bus.emit("peerlink.protocol.snapshot", {
    state: "handshake_sent",
    peerLinkId: "pl_ok",
    peerAccountId: "rez:acct:peer",
    peerInboxId: "inbox:peer",
  });
  await flush();

  assert.equal(deletedThreads.length, 0, "no thread deleted while handshake in flight");
  assert.equal(deletedContacts.length, 0, "no contact deleted while handshake in flight");
});

test("rejected snapshot without peerAccountId is a no-op", async () => {
  const { bus, svc, deletedThreads, deletedContacts } = setupService();
  await svc.start();

  bus.emit("peerlink.protocol.snapshot", {
    state: "rejected",
    peerLinkId: "pl_rej_nopeer",
    peerAccountId: null,
  });
  await flush();

  assert.equal(deletedThreads.length, 0);
  assert.equal(deletedContacts.length, 0);
});
