import test from "node:test";
import assert from "node:assert/strict";

import { KeystoreStore } from "@rezprotocol/sdk/client";
import { SessionStore, SESSION_STATUS } from "../src/ui/stores/SessionStore.js";
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
  };
}

function createOfflineSdkFactory() {
  return ({ account } = {}) => ({
    async connect() {
      throw new Error("Connect timeout");
    },
    async close() {},
    getSessionInfo() {
      return {
        accountId: account?.accountId || "rez:acct:unknown",
        capabilities: {
          deviceId: account?.deviceId || "rez:dev:unknown",
          localInboxId: "cap:local:test",
        },
      };
    },
  });
}

function createOnlineSdkFactory(metrics) {
  return ({ account } = {}) => ({
    async connect() {
      metrics.connects += 1;
    },
    async close() {
      metrics.closes += 1;
    },
    getSessionInfo() {
      return {
        accountId: account?.accountId || "rez:acct:unknown",
        capabilities: {
          deviceId: account?.deviceId || "rez:dev:unknown",
          localInboxId: "cap:local:test",
        },
      };
    },
  });
}

async function seedKeystore(storage, password) {
  const metrics = { connects: 0, closes: 0 };
  const service = createAuthHarness({
    keystoreStore: new KeystoreStore({ storageProvider: storage }),
    sdkClientFactory: createOnlineSdkFactory(metrics),
    cryptoProvider: globalThis.crypto,
    logger: console,
  });
  await service.init();
  await service.createAccount({ profileName: "Offline-Test", password });
  await service.logout();
}

test("unlock succeeds offline — authStore is UNLOCKED despite connect timeout", async () => {
  const storage = createMemoryStorage();
  const password = "test-password-123";
  await seedKeystore(storage, password);

  const service = createAuthHarness({
    authStore: new SessionStore(),
    keystoreStore: new KeystoreStore({ storageProvider: storage }),
    sdkClientFactory: createOfflineSdkFactory(),
    cryptoProvider: globalThis.crypto,
    logger: console,
  });

  await service.init();
  assert.equal(service.authStore.snapshot().status, SESSION_STATUS.LOCKED);

  const result = await service.unlock({ password });

  const snap = service.authStore.snapshot();
  assert.equal(snap.status, SESSION_STATUS.UNLOCKED, "authStore must be UNLOCKED after offline unlock");
  assert.equal(typeof snap.accountId, "string");
  assert.ok(snap.accountId.length > 0, "accountId must be non-empty");
  assert.equal(typeof snap.deviceId, "string");
  assert.ok(snap.deviceId.length > 0, "deviceId must be non-empty");

  assert.equal(typeof result.accountId, "string");
  assert.equal(typeof result.deviceId, "string");
});

test("unlock does not throw when network is unavailable", async () => {
  const storage = createMemoryStorage();
  const password = "test-password-456";
  await seedKeystore(storage, password);

  const service = createAuthHarness({
    authStore: new SessionStore(),
    keystoreStore: new KeystoreStore({ storageProvider: storage }),
    sdkClientFactory: createOfflineSdkFactory(),
    cryptoProvider: globalThis.crypto,
    logger: console,
  });

  await service.init();

  await assert.doesNotReject(
    () => service.unlock({ password }),
    "unlock must not throw due to network errors",
  );
});

test("connectClient throws when called offline after successful unlock", async () => {
  const storage = createMemoryStorage();
  const password = "test-password-789";
  await seedKeystore(storage, password);

  const service = createAuthHarness({
    authStore: new SessionStore(),
    keystoreStore: new KeystoreStore({ storageProvider: storage }),
    sdkClientFactory: createOfflineSdkFactory(),
    cryptoProvider: globalThis.crypto,
    logger: console,
  });

  await service.init();
  await service.unlock({ password });

  assert.equal(service.authStore.snapshot().status, SESSION_STATUS.UNLOCKED);

  await assert.rejects(
    () => service.connectClient(),
    (err) => err.message === "Connect timeout",
    "connectClient must propagate the network error",
  );

  assert.equal(
    service.authStore.snapshot().status,
    SESSION_STATUS.UNLOCKED,
    "authStore must remain UNLOCKED after connect failure",
  );
});
