// S2 Slice 4 (UI) — the synthetic "System" notices thread. A quarantined mailbox
// deposit (undeliverable, surfaced via runtime.event.mailbox.deposit.quarantined)
// must reach the user as a failed-message notice, never be silently dropped. This
// exercises the service + stores that own that surface: NoticesStore (the
// dedicated, MessageStore-free notice store) and SystemNoticesService (which keeps
// one ChatThread row in sync, owns the local-only archive status, and clears the
// badge on open). View rendering is covered by the row/composer/header gates; this
// is the data path.

import test from "node:test";
import assert from "node:assert/strict";
import { NoticesStore } from "../src/ui/stores/NoticesStore.js";
import { ThreadStore } from "../src/ui/stores/ThreadStore.js";
import { UiStateStore } from "../src/ui/stores/UiStateStore.js";
import { SystemNoticesService } from "../src/ui/services/bus/SystemNoticesService.js";
import { SYSTEM_NOTICES_THREAD_ID } from "../src/ui/system/systemNoticesThread.js";

function makeBus() {
  const handlers = new Map();
  return {
    on(name, fn) {
      if (!handlers.has(name)) handlers.set(name, new Set());
      handlers.get(name).add(fn);
      return () => handlers.get(name).delete(fn);
    },
    emit(name, payload) {
      const set = handlers.get(name);
      if (set) for (const fn of [...set]) fn(payload);
    },
    registerFunction() {},
    stores: {},
    services: {},
  };
}

function setup() {
  const bus = makeBus();
  const noticesStore = new NoticesStore({ bus });
  const threadStore = new ThreadStore({ bus });
  const uiStateStore = new UiStateStore({ bus });
  const service = new SystemNoticesService({ bus, noticesStore, threadStore, uiStateStore });
  return { bus, noticesStore, threadStore, uiStateStore, service };
}

function quarantine({ mailboxId = "inbox:a", seq = null, eventId = "", attempts = 3, ageMs = 0, reason = "attempts" } = {}) {
  return { mailboxId, seq, eventId, attempts, ageMs, reason };
}

test("a quarantine event surfaces as a notice and injects the System thread", () => {
  const { bus, noticesStore, threadStore } = setup();
  assert.equal(threadStore.getThread(SYSTEM_NOTICES_THREAD_ID), null, "no System thread before any notice");

  bus.emit("runtime.event.mailbox.deposit.quarantined", quarantine({ seq: 2 }));

  assert.equal(noticesStore.size(), 1, "notice stored");
  const thread = threadStore.getThread(SYSTEM_NOTICES_THREAD_ID);
  assert.ok(thread, "System thread injected");
  assert.equal(thread.threadType, "direct");
  assert.equal(thread.title, "System");
  assert.equal(thread.sendAllowed, false, "read-only: sending disallowed");
  assert.equal(thread.visibilityState, "visible");
  assert.equal(thread.unreadCount, 1, "one unread notice drives the badge");
});

test("the same dropped deposit never double-surfaces (dedup on seq)", () => {
  const { bus, noticesStore, threadStore } = setup();
  bus.emit("runtime.event.mailbox.deposit.quarantined", quarantine({ seq: 5 }));
  bus.emit("runtime.event.mailbox.deposit.quarantined", quarantine({ seq: 5 }));
  assert.equal(noticesStore.size(), 1, "duplicate seq collapses to one notice");
  assert.equal(threadStore.getThread(SYSTEM_NOTICES_THREAD_ID).unreadCount, 1);
});

test("legacy (eventId, no seq) notices key independently of seq notices", () => {
  const { bus, noticesStore } = setup();
  bus.emit("runtime.event.mailbox.deposit.quarantined", quarantine({ seq: 1 }));
  bus.emit("runtime.event.mailbox.deposit.quarantined", quarantine({ seq: null, eventId: "1", reason: "age", ageMs: 1_800_000 }));
  assert.equal(noticesStore.size(), 2, "seq:1 and eventId:1 do not collide");
});

test("opening the System thread clears its unread badge", () => {
  const { bus, threadStore, uiStateStore } = setup();
  bus.emit("runtime.event.mailbox.deposit.quarantined", quarantine({ seq: 2 }));
  bus.emit("runtime.event.mailbox.deposit.quarantined", quarantine({ seq: 3 }));
  assert.equal(threadStore.getThread(SYSTEM_NOTICES_THREAD_ID).unreadCount, 2);

  uiStateStore.setSelectedThreadId(SYSTEM_NOTICES_THREAD_ID);
  assert.equal(threadStore.getThread(SYSTEM_NOTICES_THREAD_ID).unreadCount, 0, "open marks read");

  // A notice arriving while the thread is open stays read (no badge churn).
  bus.emit("runtime.event.mailbox.deposit.quarantined", quarantine({ seq: 4 }));
  assert.equal(threadStore.getThread(SYSTEM_NOTICES_THREAD_ID).unreadCount, 0);
});

test("the synthetic row is re-injected after a force list refresh wipes the store", () => {
  const { bus, threadStore } = setup();
  bus.emit("runtime.event.mailbox.deposit.quarantined", quarantine({ seq: 2 }));
  assert.ok(threadStore.getThread(SYSTEM_NOTICES_THREAD_ID));

  // ThreadsService.ensureList({force}) does exactly this on every reconnect.
  threadStore.replaceThreads([]);
  assert.ok(threadStore.getThread(SYSTEM_NOTICES_THREAD_ID), "re-injected after threads.replaced");
});

test("archive is a local UI status (no server round-trip)", () => {
  const { bus, threadStore, uiStateStore, service } = setup();
  bus.emit("runtime.event.mailbox.deposit.quarantined", quarantine({ seq: 2 }));
  uiStateStore.setSelectedThreadId(SYSTEM_NOTICES_THREAD_ID);

  service.setArchived({ archived: true });
  assert.equal(threadStore.getThread(SYSTEM_NOTICES_THREAD_ID).visibilityState, "hidden", "archived locally");
  assert.equal(uiStateStore.selectedThreadId(), null, "archiving closes the open conversation");

  service.setArchived({ archived: false });
  assert.equal(threadStore.getThread(SYSTEM_NOTICES_THREAD_ID).visibilityState, "visible", "unarchived locally");
});
