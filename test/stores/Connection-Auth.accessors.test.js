import test from "node:test";
import assert from "node:assert/strict";
import { ConnectionStore } from "../../src/ui/stores/ConnectionStore.js";
import { AuthStore, AUTH_STATUS } from "../../src/ui/stores/AuthStore.js";

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

test("AuthStore typed status accessors reflect state", () => {
  const a = new AuthStore();
  assert.equal(a.hasKeystore(), false);
  assert.equal(a.isLocked(), false);
  assert.equal(a.isUnlocking(), false);
  assert.equal(a.isUnlocked(), false);

  a.setLocked({});
  assert.equal(a.hasKeystore(), true);
  assert.equal(a.isLocked(), true);

  a.beginUnlock();
  assert.equal(a.isUnlocking(), true);
  assert.equal(a.isLocked(), false);

  a.completeUnlock({ accountId: "v", deviceId: "d" });
  assert.equal(a.isUnlocked(), true);
  assert.equal(a.snapshot().status, AUTH_STATUS.UNLOCKED);
});
