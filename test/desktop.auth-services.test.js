import test from "node:test";
import assert from "node:assert/strict";

import { SessionStore, SESSION_STATUS } from "../src/ui/stores/SessionStore.js";
import {
  DesktopAccountAuthService,
  DesktopAuthBootstrapService,
} from "../src/ui/services/auth/DesktopAuthServices.js";

function createDesktopStub({ status, accounts, active, unlockResult } = {}) {
  const state = {
    active: active || null,
  };
  return {
    vault: {
      async status() {
        return status || { hasAccounts: false };
      },
      async listAccounts() {
        return { accounts: accounts || [] };
      },
      async getActiveIdentitySummary() {
        return state.active;
      },
      async unlock() {
        state.active = unlockResult || state.active;
        return state.active;
      },
      async createAccount() {
        state.active = unlockResult || state.active;
        return state.active;
      },
      async lock() {
        state.active = null;
        return { locked: true };
      },
    },
  };
}

test("desktop auth bootstrap reads vault status from nested runtime status shape", async () => {
  const sessionStore = new SessionStore();
  const desktop = createDesktopStub({
    status: { started: true, runtimeConnected: true, vault: { hasAccounts: true, locked: true } },
    accounts: [{ id: "acct-1", label: "Account", accountIdHint: "acct-1" }],
  });
  const bootstrap = new DesktopAuthBootstrapService({ sessionStore, desktop });

  await bootstrap.init();

  const snap = sessionStore.snapshot();
  assert.equal(snap.status, SESSION_STATUS.LOCKED);
  assert.equal(snap.selectedAccountId, "acct-1");
  assert.equal(snap.accountList.length, 1);
});

test("desktop auth keeps decrypted active profile label in UI memory after unlock", async () => {
  const sessionStore = new SessionStore();
  const unlockResult = {
    accountId: "acct-1",
    deviceId: "dev-1",
    profileName: "Ada",
    identityPublicKey: "pub-1",
  };
  const desktop = createDesktopStub({
    status: { hasAccounts: true, locked: true },
    accounts: [{ id: "acct-1", label: "Account", accountIdHint: "acct-1" }],
    unlockResult,
  });
  const bootstrap = new DesktopAuthBootstrapService({ sessionStore, desktop });
  const auth = new DesktopAccountAuthService({
    sessionStore,
    authBootstrapService: bootstrap,
    desktop,
  });

  await bootstrap.init();
  await auth.unlock({ accountId: "acct-1", password: "password123" });

  const snap = sessionStore.snapshot();
  assert.equal(snap.status, SESSION_STATUS.UNLOCKED);
  assert.equal(snap.accountList.length, 1);
  assert.equal(snap.accountList[0].label, "Ada");
});

test("desktop auth forwards enableDeviceUnlock flag to vault.unlock", async () => {
  const sessionStore = new SessionStore();
  let observedUnlockArgs = null;
  const desktop = {
    vault: {
      async status() { return { hasAccounts: true, locked: true }; },
      async listAccounts() {
        return { accounts: [{ id: "acct-1", label: "Account", accountIdHint: "acct-1", deviceUnlockEnabled: false }] };
      },
      async getActiveIdentitySummary() { return null; },
      async unlock(args) {
        observedUnlockArgs = args;
        return { accountId: "acct-1", deviceId: "dev-1", profileName: "Ada", identityPublicKey: "pub-1" };
      },
    },
  };
  const bootstrap = new DesktopAuthBootstrapService({ sessionStore, desktop });
  const auth = new DesktopAccountAuthService({ sessionStore, authBootstrapService: bootstrap, desktop });
  await bootstrap.init();
  await auth.unlock({ accountId: "acct-1", password: "p", enableDeviceUnlock: true });
  assert.equal(observedUnlockArgs.enableDeviceUnlock, true);
});

test("desktop auth unlockWithDevice routes through bridge", async () => {
  const sessionStore = new SessionStore();
  let unlockWithDeviceCalls = 0;
  const desktop = {
    vault: {
      async status() { return { hasAccounts: true, locked: true }; },
      async listAccounts() {
        return { accounts: [{ id: "acct-1", label: "Account", accountIdHint: "acct-1", deviceUnlockEnabled: true }] };
      },
      async getActiveIdentitySummary() { return null; },
      async unlockWithDevice({ accountId }) {
        unlockWithDeviceCalls += 1;
        return { accountId, deviceId: "dev-1", profileName: "Ada", identityPublicKey: "pub-1" };
      },
    },
  };
  const bootstrap = new DesktopAuthBootstrapService({ sessionStore, desktop });
  const auth = new DesktopAccountAuthService({ sessionStore, authBootstrapService: bootstrap, desktop });
  await bootstrap.init();
  const unlocked = await auth.unlockWithDevice({ accountId: "acct-1" });
  assert.equal(unlockWithDeviceCalls, 1);
  assert.equal(unlocked.accountId, "acct-1");
  assert.equal(sessionStore.snapshot().status, SESSION_STATUS.UNLOCKED);
});

test("desktop auth unlockWithDevice throws when bridge lacks the method", async () => {
  const sessionStore = new SessionStore();
  const desktop = {
    vault: {
      async status() { return { hasAccounts: true, locked: true }; },
      async listAccounts() { return { accounts: [] }; },
      async getActiveIdentitySummary() { return null; },
    },
  };
  const bootstrap = new DesktopAuthBootstrapService({ sessionStore, desktop });
  const auth = new DesktopAccountAuthService({ sessionStore, authBootstrapService: bootstrap, desktop });
  await bootstrap.init();
  await assert.rejects(
    () => auth.unlockWithDevice({ accountId: "acct-1" }),
    /unlockWithDevice/,
  );
});

test("desktop auth disableDeviceUnlock routes through bridge and refreshes list", async () => {
  const sessionStore = new SessionStore();
  let disableCalls = 0;
  let deviceUnlockState = true;
  const desktop = {
    vault: {
      async status() { return { hasAccounts: true, locked: true }; },
      async listAccounts() {
        return {
          accounts: [{ id: "acct-1", label: "Account", accountIdHint: "acct-1", deviceUnlockEnabled: deviceUnlockState }],
        };
      },
      async getActiveIdentitySummary() { return null; },
      async disableDeviceUnlock({ accountId }) {
        disableCalls += 1;
        deviceUnlockState = false;
        return { accountId, deviceUnlockEnabled: false };
      },
    },
  };
  const bootstrap = new DesktopAuthBootstrapService({ sessionStore, desktop });
  const auth = new DesktopAccountAuthService({ sessionStore, authBootstrapService: bootstrap, desktop });
  await bootstrap.init();
  assert.equal(sessionStore.snapshot().accountList[0].deviceUnlockEnabled, true);
  await auth.disableDeviceUnlock({ accountId: "acct-1" });
  assert.equal(disableCalls, 1);
  assert.equal(sessionStore.snapshot().accountList[0].deviceUnlockEnabled, false);
});
