import test from "node:test";
import assert from "node:assert/strict";

import { KeystoreStore } from "@rezprotocol/sdk/client";
import { SessionStore, SESSION_STATUS } from "../src/ui/stores/SessionStore.js";
import { AccountRegistry } from "../src/ui/services/AccountRegistry.js";
import { createAuthHarness } from "./_helpers/createAuthHarness.js";

function createMemoryStorage() {
  const mem = new Map();
  return {
    get(key) {
      return mem.has(key) ? JSON.parse(mem.get(key)) : null;
    },
    put(key, value) {
      mem.set(key, JSON.stringify(value));
    },
    del(key) {
      mem.delete(key);
    },
    listKeys() {
      return [...mem.keys()].sort();
    },
  };
}

function createSdkFactory(metrics) {
  return ({ account } = {}) => ({
    async connect() {
      metrics.connects += 1;
      metrics.lastAccount = account;
    },
    async close() {
      metrics.closes += 1;
    },
    getSessionInfo() {
      return {
        accountId: account && account.accountId ? account.accountId : "rez:acct:unknown",
        capabilities: {
          deviceId: account && account.deviceId ? account.deviceId : "rez:dev:unknown",
          localInboxId: "cap:local:test",
        },
      };
    },
  });
}

test("auth init with empty storage starts in NO_KEYSTORE", async () => {
  const storage = createMemoryStorage();
  const metrics = { connects: 0, closes: 0, lastAccount: null };
  const service = createAuthHarness({
    keystoreStore: new KeystoreStore({ storageProvider: storage }),
    sdkClientFactory: createSdkFactory(metrics),
    cryptoProvider: globalThis.crypto,
    logger: console,
  });

  await service.init();
  const snap = service.authStore.snapshot();
  assert.equal(snap.status, SESSION_STATUS.NO_KEYSTORE);
  assert.equal(metrics.connects, 0);
});

test("createAccount persists keystore and transitions to UNLOCKED", async () => {
  const storage = createMemoryStorage();
  const metrics = { connects: 0, closes: 0, lastAccount: null };
  const service = createAuthHarness({
    keystoreStore: new KeystoreStore({ storageProvider: storage }),
    sdkClientFactory: createSdkFactory(metrics),
    cryptoProvider: globalThis.crypto,
    logger: console,
  });

  await service.init();
  await service.createAccount({ profileName: "Alice", password: "password123" });
  const snap = service.authStore.snapshot();
  assert.equal(snap.status, SESSION_STATUS.UNLOCKED);
  assert.equal(typeof snap.accountId, "string");
  assert.equal(typeof snap.deviceId, "string");
  assert.equal(metrics.connects, 0, "unlock no longer calls connect");

  await service.connectClient();
  assert.equal(metrics.connects, 1, "explicit connectClient triggers connect");

  const envelope = await new KeystoreStore({ storageProvider: storage }).getKeystoreEnvelope();
  assert.equal(envelope != null, true);
});

test("reload with existing keystore starts LOCKED; wrong password fails closed", async () => {
  const storage = createMemoryStorage();

  const seededMetrics = { connects: 0, closes: 0, lastAccount: null };
  const seeded = createAuthHarness({
    keystoreStore: new KeystoreStore({ storageProvider: storage }),
    sdkClientFactory: createSdkFactory(seededMetrics),
    cryptoProvider: globalThis.crypto,
    logger: console,
  });
  await seeded.init();
  await seeded.createAccount({ profileName: "Bob", password: "password123" });
  await seeded.logout();

  const metrics = { connects: 0, closes: 0, lastAccount: null };
  const service = createAuthHarness({
    keystoreStore: new KeystoreStore({ storageProvider: storage }),
    sdkClientFactory: createSdkFactory(metrics),
    cryptoProvider: globalThis.crypto,
    logger: console,
  });

  await service.init();
  assert.equal(service.authStore.snapshot().status, SESSION_STATUS.LOCKED);
  assert.equal(metrics.connects, 0);

  await assert.rejects(service.unlock({ password: "wrong-password" }));
  const failed = service.authStore.snapshot();
  assert.equal(failed.status, SESSION_STATUS.LOCKED);
  assert.equal(metrics.connects, 0);

  await service.unlock({ password: "password123" });
  const unlocked = service.authStore.snapshot();
  assert.equal(unlocked.status, SESSION_STATUS.UNLOCKED);
  assert.equal(metrics.connects, 0, "unlock no longer calls connect");

  await service.connectClient();
  assert.equal(metrics.connects, 1, "explicit connectClient triggers connect");
});

test("logout transitions to LOCKED and closes active sdk client", async () => {
  const storage = createMemoryStorage();
  const metrics = { connects: 0, closes: 0, lastAccount: null };
  const service = createAuthHarness({
    keystoreStore: new KeystoreStore({ storageProvider: storage }),
    sdkClientFactory: createSdkFactory(metrics),
    cryptoProvider: globalThis.crypto,
    logger: console,
  });

  await service.init();
  await service.createAccount({ profileName: "Cara", password: "password123" });
  assert.equal(service.authStore.snapshot().status, SESSION_STATUS.UNLOCKED);

  await service.connectClient();
  assert.equal(metrics.connects, 1);

  await service.logout();
  const locked = service.authStore.snapshot();
  assert.equal(locked.status, SESSION_STATUS.LOCKED);
  assert.equal(metrics.closes > 0, true);
});

test("listAccounts with registry returns empty when no accounts", async () => {
  const storage = createMemoryStorage();
  const registry = new AccountRegistry({ storageProvider: storage });
  const metrics = { connects: 0, closes: 0, lastAccount: null };
  const service = createAuthHarness({
    storageProvider: storage,
    accountRegistry: registry,
    sdkClientFactory: createSdkFactory(metrics),
    cryptoProvider: globalThis.crypto,
    logger: console,
  });

  await service.init();
  const list = await service.listAccounts();
  assert.equal(Array.isArray(list), true);
  assert.equal(list.length, 0);
  assert.equal(service.authStore.snapshot().status, SESSION_STATUS.NO_KEYSTORE);
});

test("createAccount with registry sets label to profileName and listAccounts returns it", async () => {
  const storage = createMemoryStorage();
  const registry = new AccountRegistry({ storageProvider: storage });
  const metrics = { connects: 0, closes: 0, lastAccount: null };
  const service = createAuthHarness({
    storageProvider: storage,
    accountRegistry: registry,
    sdkClientFactory: createSdkFactory(metrics),
    cryptoProvider: globalThis.crypto,
    logger: console,
  });

  await service.init();
  await service.createAccount({ profileName: "Work", password: "secret99" });
  const list = await service.listAccounts();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, "default");
  assert.equal(list[0].label, "Work");
  assert.equal(service.authStore.snapshot().status, SESSION_STATUS.UNLOCKED);
  const revealed = await service.accountAuthService.revealMnemonic({ password: "secret99" });
  assert.equal(revealed.mnemonic.split(" ").length, 24, "browser account creation must produce a recovery phrase");
  assert.equal(
    typeof service.getAccount().accountIdentityDhKeyPair.publicKeyB64,
    "string",
    "unlocked browser account carries its seed-derived account DH key",
  );
});

test("browser account creation removes encrypted artifacts when registry admission fails", async () => {
  const storage = createMemoryStorage();
  const registry = new AccountRegistry({ storageProvider: storage });
  registry.addAccount = async () => {
    throw new Error("registry unavailable");
  };
  const service = createAuthHarness({
    storageProvider: storage,
    accountRegistry: registry,
    sdkClientFactory: createSdkFactory({ connects: 0, closes: 0, lastAccount: null }),
    cryptoProvider: globalThis.crypto,
    logger: console,
  });
  await service.init();

  await assert.rejects(
    () => service.createAccount({ profileName: "Orphan", password: "password123" }),
    /registry unavailable/,
  );
  assert.equal(await service.authBootstrapService.getKeystoreStore("default").hasKeystore(), false);
  assert.equal(await service.authBootstrapService.getRecoveryStore("default").hasKeystore(), false);
});

test("browser recovery removes registry entry and envelopes when identity hint persistence fails", async () => {
  const sourceStorage = createMemoryStorage();
  const source = createAuthHarness({
    storageProvider: sourceStorage,
    accountRegistry: new AccountRegistry({ storageProvider: sourceStorage }),
    sdkClientFactory: createSdkFactory({ connects: 0, closes: 0, lastAccount: null }),
    cryptoProvider: globalThis.crypto,
    logger: console,
  });
  await source.init();
  await source.createAccount({ profileName: "Source", password: "password123" });
  const recovery = await source.accountAuthService.revealMnemonic({ password: "password123" });

  const targetStorage = createMemoryStorage();
  const targetRegistry = new AccountRegistry({ storageProvider: targetStorage });
  targetRegistry.setAccountIdHint = async () => {
    throw new Error("hint unavailable");
  };
  const target = createAuthHarness({
    storageProvider: targetStorage,
    accountRegistry: targetRegistry,
    sdkClientFactory: createSdkFactory({ connects: 0, closes: 0, lastAccount: null }),
    cryptoProvider: globalThis.crypto,
    logger: console,
  });
  await target.init();

  await assert.rejects(
    () => target.accountAuthService.restoreWithMnemonic({
      mnemonic: recovery.mnemonic,
      newPassword: "password456",
      profileName: "Recovered",
    }),
    /hint unavailable/,
  );
  assert.deepEqual(await target.listAccounts(), []);
  assert.equal(await target.authBootstrapService.getKeystoreStore("default").hasKeystore(), false);
  assert.equal(await target.authBootstrapService.getRecoveryStore("default").hasKeystore(), false);
});

test("browser account password change preserves account and device identity", async () => {
  const storage = createMemoryStorage();
  const service = createAuthHarness({
    storageProvider: storage,
    accountRegistry: new AccountRegistry({ storageProvider: storage }),
    sdkClientFactory: createSdkFactory({ connects: 0, closes: 0, lastAccount: null }),
    cryptoProvider: globalThis.crypto,
    logger: console,
  });
  await service.init();
  await service.createAccount({ profileName: "Stable", password: "password-old" });
  const before = service.getAccount();
  await service.accountAuthService.changePassword({
    accountId: before.accountId,
    oldPassword: "password-old",
    newPassword: "password-new",
  });
  await assert.rejects(() => service.unlock({ password: "password-old" }));
  await service.unlock({ password: "password-new" });
  const after = service.getAccount();
  assert.equal(after.accountId, before.accountId);
  assert.equal(after.deviceId, before.deviceId);
  assert.deepEqual(after.deviceKeyPair, before.deviceKeyPair);
  assert.equal((await service.accountAuthService.revealMnemonic({ password: "password-new" })).mnemonic.split(" ").length, 24);
});

test("browser account purge verifies the password and removes vault plus recovery state", async () => {
  const storage = createMemoryStorage();
  const service = createAuthHarness({
    storageProvider: storage,
    accountRegistry: new AccountRegistry({ storageProvider: storage }),
    sdkClientFactory: createSdkFactory({ connects: 0, closes: 0, lastAccount: null }),
    cryptoProvider: globalThis.crypto,
    logger: console,
  });
  await service.init();
  await service.createAccount({ profileName: "Disposable", password: "password-delete" });
  await assert.rejects(
    () => service.accountAuthService.purgeAccount({ password: "wrong-password" }),
  );
  assert.equal((await service.listAccounts()).length, 1);
  const purged = await service.accountAuthService.purgeAccount({ password: "password-delete" });
  assert.equal(purged.deleted, true);
  assert.equal((await service.listAccounts()).length, 0);
  assert.equal(await storage.get("default"), null);
  assert.equal(await storage.get("recovery:default"), null);
  assert.equal(service.authStore.snapshot().status, SESSION_STATUS.NO_KEYSTORE);
});

test("browser recovery phrase restores the same account root as a fresh device", async () => {
  const sourceStorage = createMemoryStorage();
  const source = createAuthHarness({
    storageProvider: sourceStorage,
    accountRegistry: new AccountRegistry({ storageProvider: sourceStorage }),
    sdkClientFactory: createSdkFactory({ connects: 0, closes: 0, lastAccount: null }),
    cryptoProvider: globalThis.crypto,
    logger: console,
  });
  await source.init();
  await source.createAccount({ profileName: "Source", password: "password-source" });
  const sourceAccount = source.getAccount();
  const revealed = await source.accountAuthService.revealMnemonic({ password: "password-source" });

  const targetStorage = createMemoryStorage();
  const target = createAuthHarness({
    storageProvider: targetStorage,
    accountRegistry: new AccountRegistry({ storageProvider: targetStorage }),
    sdkClientFactory: createSdkFactory({ connects: 0, closes: 0, lastAccount: null }),
    cryptoProvider: globalThis.crypto,
    logger: console,
  });
  await target.init();
  await target.accountAuthService.restoreWithMnemonic({
    mnemonic: revealed.mnemonic,
    newPassword: "password-target",
    profileName: "Recovered",
  });
  const recovered = target.getAccount();
  assert.equal(recovered.accountId, sourceAccount.accountId);
  assert.notEqual(recovered.deviceId, sourceAccount.deviceId);
  assert.deepEqual(recovered.identityKeyPair, sourceAccount.identityKeyPair);
  assert.deepEqual(recovered.accountIdentityDhKeyPair, sourceAccount.accountIdentityDhKeyPair);
  assert.equal((await target.listAccounts())[0].label, "Recovered");
});

test("init rebuilds registry from discovered local keystore keys", async () => {
  const storage = createMemoryStorage();
  const registry = new AccountRegistry({ storageProvider: storage });
  const metrics = { connects: 0, closes: 0, lastAccount: null };
  const seeded = createAuthHarness({
    storageProvider: storage,
    accountRegistry: registry,
    sdkClientFactory: createSdkFactory(metrics),
    cryptoProvider: globalThis.crypto,
    logger: console,
  });

  await seeded.init();
  await seeded.createAccount({ profileName: "Recovered", password: "password123" });
  await seeded.logout();
  await storage.put("rez:account-hints", { accountIds: [], hints: {} });

  const reloaded = createAuthHarness({
    authStore: new SessionStore(),
    storageProvider: storage,
    accountRegistry: new AccountRegistry({ storageProvider: storage }),
    sdkClientFactory: createSdkFactory({ connects: 0, closes: 0, lastAccount: null }),
    cryptoProvider: globalThis.crypto,
    logger: console,
  });

  await reloaded.init();
  const snap = reloaded.authStore.snapshot();
  assert.equal(snap.status, SESSION_STATUS.LOCKED);
  assert.equal(Array.isArray(snap.accountList), true);
  assert.equal(snap.accountList.length, 1);
  assert.equal(snap.accountList[0].id, "default");
});

test("inspectBootstrap reports orphan local keystore keys when registry is empty", async () => {
  const storage = createMemoryStorage();
  const seeded = createAuthHarness({
    storageProvider: storage,
    accountRegistry: new AccountRegistry({ storageProvider: storage }),
    sdkClientFactory: createSdkFactory({ connects: 0, closes: 0, lastAccount: null }),
    cryptoProvider: globalThis.crypto,
    logger: console,
  });

  await seeded.init();
  await seeded.createAccount({ profileName: "Recovered", password: "password123" });
  await seeded.logout();
  await storage.put("rez:account-hints", { accountIds: [], hints: {} });

  const service = createAuthHarness({
    storageProvider: storage,
    accountRegistry: new AccountRegistry({ storageProvider: storage }),
    sdkClientFactory: createSdkFactory({ connects: 0, closes: 0, lastAccount: null }),
    cryptoProvider: globalThis.crypto,
    logger: console,
  });

  const diagnostic = await service.inspectBootstrap();
  const json = diagnostic.toJSON();
  assert.equal(json.diagnostic.registryPresent, true);
  assert.equal(Array.isArray(json.diagnostic.discoveredEnvelopeKeys), true);
  assert.equal(json.diagnostic.discoveredEnvelopeKeys.includes("default"), true);
  assert.equal(Array.isArray(json.diagnostic.orphanEnvelopeKeys), true);
  assert.equal(json.diagnostic.orphanEnvelopeKeys.includes("default"), true);
});

test("unlock with accountId and registry unlocks correct account", async () => {
  const storage = createMemoryStorage();
  const registry = new AccountRegistry({ storageProvider: storage });
  const metrics = { connects: 0, closes: 0, lastAccount: null };
  const service = createAuthHarness({
    storageProvider: storage,
    accountRegistry: registry,
    sdkClientFactory: createSdkFactory(metrics),
    cryptoProvider: globalThis.crypto,
    logger: console,
  });

  await service.init();
  await service.createAccount({ profileName: "Alice", password: "password123" });
  await service.logout();

  await service.init();
  assert.equal(service.authStore.snapshot().status, SESSION_STATUS.LOCKED);
  await service.unlock({ accountId: "default", password: "password123" });
  const snap = service.authStore.snapshot();
  assert.equal(snap.status, SESSION_STATUS.UNLOCKED);
  assert.equal(metrics.connects, 0, "unlock no longer calls connect");

  await service.connectClient();
  assert.ok(metrics.connects >= 1, "connectClient should connect sdk client");
});
