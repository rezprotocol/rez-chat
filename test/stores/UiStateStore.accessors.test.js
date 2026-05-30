import test from "node:test";
import assert from "node:assert/strict";
import { UiStateStore } from "../../src/ui/stores/UiStateStore.js";

function makeStore() {
  return new UiStateStore({ bus: null });
}

test("UiStateStore.activeTab() defaults to chat and normalizes unknowns", () => {
  const s = makeStore();
  assert.equal(s.activeTab(), "chat");
  s.setActiveTab("contacts");
  assert.equal(s.activeTab(), "contacts");
  s.setActiveTab("settings");
  assert.equal(s.activeTab(), "settings");
  s.setActiveTab("profile");
  assert.equal(s.activeTab(), "profile");
});

test("UiStateStore.authScreen() defaults to unlock", () => {
  const s = makeStore();
  assert.equal(s.authScreen(), "unlock");
  s.setAuthScreen("create");
  assert.equal(s.authScreen(), "create");
  s.setAuthScreen("unlock");
  assert.equal(s.authScreen(), "unlock");
});

test("UiStateStore.selectedThreadId() returns null when not set", () => {
  const s = makeStore();
  assert.equal(s.selectedThreadId(), null);
  s.setSelectedThreadId("th_a");
  assert.equal(s.selectedThreadId(), "th_a");
  s.setSelectedThreadId(null);
  assert.equal(s.selectedThreadId(), null);
});

test("UiStateStore.selectedContactGroupId() returns null when not set", () => {
  const s = makeStore();
  assert.equal(s.selectedContactGroupId(), null);
  s.setSelectedContactGroupId("g_a");
  assert.equal(s.selectedContactGroupId(), "g_a");
  s.setSelectedContactGroupId(null);
  assert.equal(s.selectedContactGroupId(), null);
});

test("UiStateStore.threadListFilters() returns a copy", () => {
  const s = makeStore();
  assert.deepEqual(s.threadListFilters(), ["all"]);
  s.setThreadListFilters(["dms", "groups"]);
  const out = s.threadListFilters();
  assert.deepEqual(out, ["dms", "groups"]);
  out.push("locked");
  assert.deepEqual(s.threadListFilters(), ["dms", "groups"]);
});
