import test from "node:test";
import assert from "node:assert/strict";
import { SessionStore } from "../src/ui/stores/SessionStore.js";
import { AuthBootstrapService } from "../src/ui/services/auth/AuthBootstrapService.js";

const storageProvider = { get() {}, put() {} };
const accountRegistry = { listAccounts: async () => [] };
const authStore = new SessionStore();
const authService = new AuthBootstrapService({
  sessionStore: authStore,
  storageProvider,
  accountRegistry,
});

const accountList = [
  { id: "acct_a", label: "A" },
  { id: "acct_b", label: "B" },
];
authStore.setAccountList(accountList);
authStore.setSelectedAccountId("acct_a");

test("selectAccount selects existing account and returns true", () => {
  const result = authService.selectAccount({ accountId: "acct_b" });
  assert.equal(result, true);
  assert.equal(authStore.snapshot().selectedAccountId, "acct_b");
});

test("selectAccount with non-existent id returns false and leaves selectedAccountId unchanged", () => {
  authService.selectAccount({ accountId: "acct_b" });
  const result = authService.selectAccount({ accountId: "does_not_exist" });
  assert.equal(result, false);
  assert.equal(authStore.snapshot().selectedAccountId, "acct_b");
});
