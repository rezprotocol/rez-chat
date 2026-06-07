// Regression (2026-06-07): offline-delivered messages now actually arrive at
// boot/reconnect catch-up (the push-before-handshake/join fix). Their unread
// counts are persisted server-side and present in the threads.list snapshot, but
// the incremental thread.index.updated events for that catch-up burst can be
// missed by the renderer (emitted before it is ready / dropped on connection
// churn), leaving stale unread badges. ThreadsService must reconcile the thread
// list against the server snapshot on every session connect — a FORCE refetch
// that runs even when the store is already loaded. Mirrors ChannelsService's
// session-connect sync. See project_offline_push_before_handshake_race.

import test from "node:test";
import assert from "node:assert/strict";

import { ThreadsService } from "../src/ui/services/bus/ThreadsService.js";

function makeBus(snapshotThreads) {
  const handlers = new Map();
  const calls = [];
  return {
    handlers,
    calls,
    on(name, handler) {
      if (!handlers.has(name)) handlers.set(name, []);
      handlers.get(name).push(handler);
      return () => {};
    },
    emit(name, payload) {
      const list = handlers.get(name) || [];
      for (const h of list) h(payload);
    },
    registerFunction() {},
    runtime: {
      client: {
        call(method, params) {
          calls.push({ method, params });
          if (method === "threads.list") {
            return Promise.resolve({ threads: snapshotThreads, cursor: null });
          }
          return Promise.resolve(null);
        },
      },
    },
  };
}

function makeStores() {
  let loaded = true; // simulate the thread list already loaded at boot
  let replaced = null;
  const threadStore = {
    isLoaded() { return loaded; },
    getThreads() { return replaced || []; },
    getThread() { return null; },
    upsertThread() {},
    replaceThreads(threads) { replaced = threads; loaded = true; },
    get lastReplaced() { return replaced; },
  };
  const uiStateStore = {
    onChange() { return () => {}; },
    snapshot() { return { threadListFilters: ["all"], selectedThreadId: null }; },
    selectedThreadId() { return null; },
    setSelectedThreadId() {},
  };
  return { threadStore, messageStore: {}, uiStateStore };
}

test("session-connect forces a thread-list reconcile even when already loaded", async () => {
  const snapshot = [
    { threadId: "th_group", threadType: "group", unreadCount: 2, unreadByChannelId: { "": 2 } },
  ];
  const bus = makeBus(snapshot);
  const stores = makeStores();
  const service = new ThreadsService({ bus, ...stores });

  // Sanity: a non-force ensureList is a no-op while loaded (no server call).
  await service.ensureList({});
  assert.equal(bus.calls.length, 0, "loaded store does not refetch without force");

  // The session connect must FORCE a refetch and replace the local threads with
  // the authoritative snapshot (carrying the catch-up unread counts).
  bus.emit("session.runtime.connected", {});
  await new Promise((r) => setTimeout(r, 0)); // let the fire-and-forget settle

  const listCalls = bus.calls.filter((c) => c.method === "threads.list");
  assert.equal(listCalls.length, 1, "session connect triggers exactly one threads.list refetch");
  assert.ok(stores.threadStore.lastReplaced, "the thread store was replaced from the snapshot");
  const grp = stores.threadStore.lastReplaced.find((t) => t.threadId === "th_group");
  assert.ok(grp, "group thread present after reconcile");
  assert.equal(grp.unreadCount, 2, "unread badge reconciled to the server snapshot count");

  service.stop();
});
