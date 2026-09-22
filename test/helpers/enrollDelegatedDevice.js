import { AccountRegistry } from "../../src/ui/services/AccountRegistry.js";
import { AccountAuthService } from "../../src/ui/services/auth/AccountAuthService.js";
import { AuthBootstrapService } from "../../src/ui/services/auth/AuthBootstrapService.js";
import { SessionStore } from "../../src/ui/stores/SessionStore.js";
import { createDeviceLinkRunner, runDeviceLinkRequester } from "../../src/client/runtime/DeviceLinkRunner.js";

class EnrollmentStorageProvider {
  #keystore;
  #values = new Map();
  constructor(keystore) { this.#keystore = keystore; }
  async get(key) {
    if (key === "default") return this.#keystore.getKeystoreEnvelope();
    return this.#values.has(key) ? this.#values.get(key) : null;
  }
  async put(key, value) {
    if (key === "default") return this.#keystore.putKeystoreEnvelope(value);
    this.#values.set(key, value);
    return value;
  }
  async del(key) {
    if (key === "default") {
      await this.#keystore.clearKeystore();
      return true;
    }
    return this.#values.delete(key);
  }
  async listKeys() {
    const keys = Array.from(this.#values.keys());
    if (await this.#keystore.hasKeystore()) keys.push("default");
    return keys;
  }
}

export async function enrollDelegatedDevice({
  linkCode,
  password,
  profileName = "",
  cryptoProvider,
  keystoreCryptoProvider = null,
  wsFactory,
  uplinks,
  keystoreStore,
  clock = () => Date.now(),
  expectedNodePublicKeyB64 = "",
  timeoutMs = 180_000,
  onStatus = null,
  logger = console,
  sdkFactory,
  requester,
} = {}) {
  if (!keystoreStore) throw new Error("enrollDelegatedDevice requires keystoreStore");
  if (await keystoreStore.hasKeystore()) throw new Error("keystoreStore already holds an envelope");
  const storageProvider = new EnrollmentStorageProvider(keystoreStore);
  const sessionStore = new SessionStore();
  const bootstrap = new AuthBootstrapService({
    sessionStore,
    storageProvider,
    accountRegistry: new AccountRegistry({ storageProvider }),
    logger,
  });
  await bootstrap.init();
  const runner = createDeviceLinkRunner({
    uplinks,
    cryptoProvider,
    wsFactory,
    expectedNodePublicKeyB64,
    clock,
    logger,
    runner: (params) => runDeviceLinkRequester({
      ...params,
      timeoutMs,
      sdkFactory,
      requester,
      onStatus,
    }),
  });
  const auth = new AccountAuthService({
    sessionStore,
    authBootstrapService: bootstrap,
    cryptoProvider: keystoreCryptoProvider,
    deviceLinkRunner: runner,
    logger,
  });
  await auth.linkDevice({ linkCode, password, profileName });
  const account = auth.getAccount();
  return {
    accountId: account.accountId,
    deviceId: account.deviceId,
    bootstrapInboxId: account.bootstrapInboxId,
  };
}
