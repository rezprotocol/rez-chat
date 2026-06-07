import test from "node:test";
import assert from "node:assert/strict";
import { ConnectionStore } from "../../src/ui/stores/ConnectionStore.js";

test("ConnectionStore.isOnline true only when status === connected", () => {
  const c = new ConnectionStore();
  assert.equal(c.isOnline(), false);
  c.setConnection({ status: "connecting" });
  assert.equal(c.isOnline(), false);
  c.setConnection({ status: "connected" });
  assert.equal(c.isOnline(), true);
  c.setConnection({ status: "disconnected" });
  assert.equal(c.isOnline(), false);
});

test("ConnectionStore.status / lastError typed accessors", () => {
  const c = new ConnectionStore();
  c.setConnection({ status: "connecting", lastError: null });
  assert.equal(c.status(), "connecting");
  assert.equal(c.lastError(), null);
  c.setConnection({ lastError: "boom" });
  assert.equal(c.lastError(), "boom");
});

test("ConnectionStore.isInboxSynced reflects the inbox.caughtup readiness signal", () => {
  const c = new ConnectionStore();
  // Defaults to NOT synced — fresh login asserts "syncing", not real state.
  assert.equal(c.isInboxSynced(), false);
  // ConnectionService flips this true when the server emits inbox.caughtup.
  c.setConnection({ inboxSynced: true });
  assert.equal(c.isInboxSynced(), true);
  // A fresh connect/disconnect resets it — catch-up will run again.
  c.setConnection({ status: "connected", inboxSynced: false });
  assert.equal(c.isInboxSynced(), false);
  // Survives unrelated patches (clone preserves the flag).
  c.setConnection({ inboxSynced: true });
  c.setConnection({ lastError: "x" });
  assert.equal(c.isInboxSynced(), true);
});
