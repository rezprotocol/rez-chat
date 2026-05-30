import test from "node:test";
import assert from "node:assert/strict";
import { SessionStore, SESSION_STATUS } from "../../src/ui/stores/SessionStore.js";

function makeStore() {
  return new SessionStore({ bus: null });
}

test("SessionStore.chatAccountId() returns ownerAccountId when unlocked", () => {
  const s = makeStore();
  s.setUnlocked({
    accountId: "vault_a",
    deviceId: "dev_a",
    ownerAccountId: "peer_a",
    localInboxId: "ibx_a",
  });
  assert.equal(s.chatAccountId(), "peer_a");
});

test("SessionStore.chatAccountId() returns null when no ownerAccountId", () => {
  const s = makeStore();
  assert.equal(s.chatAccountId(), null);
});

test("SessionStore.vaultAccountId() returns accountId distinct from chatAccountId", () => {
  const s = makeStore();
  s.setUnlocked({
    accountId: "vault_a",
    deviceId: "dev_a",
    ownerAccountId: "peer_a",
  });
  assert.equal(s.vaultAccountId(), "vault_a");
  assert.notEqual(s.vaultAccountId(), s.chatAccountId());
});

test("SessionStore.isSelf() matches either identity slot", () => {
  const s = makeStore();
  s.setUnlocked({
    accountId: "vault_a",
    deviceId: "dev_a",
    ownerAccountId: "peer_a",
    localInboxId: "ibx_a",
  });
  assert.equal(s.isSelf("vault_a"), true);
  assert.equal(s.isSelf("peer_a"), true);
  assert.equal(s.isSelf("ibx_a"), true);
  assert.equal(s.isSelf("someone_else"), false);
  assert.equal(s.isSelf(""), false);
  assert.equal(s.isSelf(null), false);
});

test("SessionStore.isSelf() matches accountList hints", () => {
  const s = makeStore();
  s.setUnlocked({ accountId: "vault_a", deviceId: "dev_a", ownerAccountId: "peer_a" });
  s.setAccountList([{ accountIdHint: "hinted_a" }, { accountIdHint: "hinted_b" }]);
  assert.equal(s.isSelf("hinted_a"), true);
  assert.equal(s.isSelf("hinted_b"), true);
});

test("SessionStore.isUnlocked() reflects status", () => {
  const s = makeStore();
  assert.equal(s.isUnlocked(), false);
  s.setUnlocked({ accountId: "v", deviceId: "d", ownerAccountId: "p" });
  assert.equal(s.isUnlocked(), true);
  s.setLocked();
  assert.equal(s.isUnlocked(), false);
  assert.equal(s.snapshot().status, SESSION_STATUS.LOCKED);
});

test("SessionStore.deviceId() and localInboxId() return null when empty", () => {
  const s = makeStore();
  assert.equal(s.deviceId(), null);
  assert.equal(s.localInboxId(), null);
  s.setUnlocked({ accountId: "v", deviceId: "d", ownerAccountId: "p", localInboxId: "i" });
  assert.equal(s.deviceId(), "d");
  assert.equal(s.localInboxId(), "i");
});

test("SessionStore.status() returns the raw status string", () => {
  const s = makeStore();
  assert.equal(s.status(), SESSION_STATUS.NO_KEYSTORE);
  s.setLocked();
  assert.equal(s.status(), SESSION_STATUS.LOCKED);
  s.setUnlocked({ accountId: "v", deviceId: "d", ownerAccountId: "p" });
  assert.equal(s.status(), SESSION_STATUS.UNLOCKED);
});

test("SessionStore.error() returns null or trimmed string", () => {
  const s = makeStore();
  assert.equal(s.error(), null);
  s.setError("bad password");
  assert.equal(s.error(), "bad password");
  s.setError(null);
  assert.equal(s.error(), null);
});

test("SessionStore.initStep() returns null or the current step", () => {
  const s = makeStore();
  assert.equal(s.initStep(), null);
  s.setInitStep("CONNECTING_TO_REZNET");
  assert.equal(s.initStep(), "CONNECTING_TO_REZNET");
  s.setInitStep(null);
  assert.equal(s.initStep(), null);
});

test("SessionStore.accountList() returns a defensive copy", () => {
  const s = makeStore();
  assert.deepEqual(s.accountList(), []);
  s.setAccountList([{ id: "a", label: "Alpha" }, { id: "b", label: "Beta" }]);
  const out = s.accountList();
  assert.equal(out.length, 2);
  out.push({ id: "z" });
  assert.equal(s.accountList().length, 2);
});

test("SessionStore.selectedAccountIdRaw() returns null until explicitly selected", () => {
  const s = makeStore();
  assert.equal(s.selectedAccountIdRaw(), null);
  s.setSelectedAccountId("a");
  assert.equal(s.selectedAccountIdRaw(), "a");
  s.setSelectedAccountId(null);
  assert.equal(s.selectedAccountIdRaw(), null);
});

test("SessionStore.selectedOrVaultAccountId() prefers selected then vault", () => {
  const s = makeStore();
  assert.equal(s.selectedOrVaultAccountId(), null);
  s.setUnlocked({ accountId: "vault_a", deviceId: "d", ownerAccountId: "peer_a" });
  assert.equal(s.selectedOrVaultAccountId(), "vault_a");
  s.setSelectedAccountId("sel_b");
  assert.equal(s.selectedOrVaultAccountId(), "sel_b");
});

test("SessionStore.accountEntry() matches by id or accountIdHint", () => {
  const s = makeStore();
  s.setAccountList([
    { id: "row_a", label: "Alpha", accountIdHint: "hint_a" },
    { id: "row_b", label: "Beta" },
  ]);
  assert.equal(s.accountEntry("row_a").label, "Alpha");
  assert.equal(s.accountEntry("hint_a").label, "Alpha");
  assert.equal(s.accountEntry("row_b").label, "Beta");
  assert.equal(s.accountEntry("nope"), null);
  assert.equal(s.accountEntry(""), null);
});

test("SessionStore.selectedAccountEntry() uses selected then vault id", () => {
  const s = makeStore();
  s.setAccountList([
    { id: "row_a", label: "Alpha", accountIdHint: "vault_a" },
    { id: "row_b", label: "Beta" },
  ]);
  s.setUnlocked({ accountId: "vault_a", deviceId: "d", ownerAccountId: "peer_a" });
  assert.equal(s.selectedAccountEntry().label, "Alpha");
  s.setSelectedAccountId("row_b");
  assert.equal(s.selectedAccountEntry().label, "Beta");
});

test("SessionStore.otherAccountEntries() omits the selected row", () => {
  const s = makeStore();
  s.setAccountList([
    { id: "row_a", label: "Alpha" },
    { id: "row_b", label: "Beta" },
    { id: "row_c", label: "Gamma" },
  ]);
  s.setSelectedAccountId("row_b");
  const others = s.otherAccountEntries();
  assert.equal(others.length, 2);
  assert.equal(others[0].id, "row_a");
  assert.equal(others[1].id, "row_c");
});

test("SessionStore.selfLabel() returns selected entry label or null", () => {
  const s = makeStore();
  assert.equal(s.selfLabel(), null);
  s.setAccountList([{ id: "row_a", label: "Alpha", accountIdHint: "vault_a" }]);
  s.setUnlocked({ accountId: "vault_a", deviceId: "d", ownerAccountId: "peer_a" });
  assert.equal(s.selfLabel(), "Alpha");
  s.setAccountList([{ id: "row_a", label: "", accountIdHint: "vault_a" }]);
  assert.equal(s.selfLabel(), null);
});

test("SessionStore.labelForAccountId() looks up any row label", () => {
  const s = makeStore();
  s.setAccountList([
    { id: "row_a", label: "Alpha" },
    { id: "row_b", label: "Beta", accountIdHint: "hint_b" },
  ]);
  assert.equal(s.labelForAccountId("row_a"), "Alpha");
  assert.equal(s.labelForAccountId("hint_b"), "Beta");
  assert.equal(s.labelForAccountId("nope"), null);
});
