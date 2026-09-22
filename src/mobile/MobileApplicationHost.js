import { BrowserCryptoProvider } from "@rezprotocol/sdk/client";
import { installNativePlatform, NativeStorageProvider } from "@rezprotocol/sdk/native";
import { createDeviceLinkRunner } from "../client/runtime/DeviceLinkRunner.js";
import { AccountRegistry } from "../ui/services/AccountRegistry.js";
import { AccountAuthService } from "../ui/services/auth/AccountAuthService.js";
import { AuthBootstrapService } from "../ui/services/auth/AuthBootstrapService.js";
import { SessionStore } from "../ui/stores/SessionStore.js";
import { MobileRuntimeHost } from "./MobileRuntimeHost.js";
import {
  LegacyMobileVaultRecordV1,
  MobileAccountListV1,
  MobileAuthParamsV1,
  MobileAvatarV1,
  MobileBackgroundReportV1,
  MobileHostConfigV1,
  MobileHostRequestV1,
  MobileHostResponseV1,
  MobileIdentitySummaryV1,
  MobileLifecycleRequestV1,
  MobileLifecycleResultV1,
  MobileMnemonicResultV1,
  MobileProfileParamsV1,
  MobileVaultStatusV1,
} from "./MobileHostRecords.js";
import { MOBILE_AUTH_MUTATIONS, MOBILE_PROFILE_OPERATIONS } from "./MobileHostSpec.js";
import { MobileAccountSocketGate } from "./MobileAccountSocketGate.js";

export class MobileApplicationHost {
  #storage;
  #session;
  #bootstrap;
  #auth;
  #runtime;
  #emit;
  #ready;
  #tail = Promise.resolve();
  #lifecycleBarrier = null;
  #accountSockets;
  constructor(config, primitive, emit) {
    if (!(config instanceof MobileHostConfigV1)) throw new Error("MobileHostConfigV1 required");
    this.#storage = new NativeStorageProvider(primitive);
    this.#session = new SessionStore();
    const accountRegistry = new AccountRegistry({ storageProvider: this.#storage });
    this.#bootstrap = new AuthBootstrapService({
      sessionStore: this.#session,
      storageProvider: this.#storage,
      accountRegistry,
      logger: console,
    });
    const crypto = new BrowserCryptoProvider();
    this.#accountSockets = new MobileAccountSocketGate((url) => new WebSocket(url));
    const accountSocket = (url) => this.#accountSockets.open(url);
    this.#auth = new AccountAuthService({
      sessionStore: this.#session,
      authBootstrapService: this.#bootstrap,
      cryptoProvider: null,
      deviceLinkRunner: createDeviceLinkRunner({
        uplinks: config.accountHomeUplinks,
        cryptoProvider: crypto,
        wsFactory: accountSocket,
        expectedNodePublicKeyB64: config.accountHomePin,
        logger: console,
      }),
      logger: console,
    });
    this.#runtime = new MobileRuntimeHost(this.#storage, crypto, config, emit, accountSocket);
    this.#emit = emit;
    this.#ready = this.#initialize();
  }
  async #initialize() {
    await this.#migrateLegacyVault();
    await this.#bootstrap.init();
  }
  async #migrateLegacyVault() {
    const legacyStore = this.#storage.getKeyValueStore("mobile:vault");
    const raw = await legacyStore.getStrict("account");
    if (raw === undefined) return;
    const legacy = new LegacyMobileVaultRecordV1(raw);
    const existing = await this.#storage.get("default");
    if (existing !== null && JSON.stringify(existing) !== JSON.stringify(legacy.envelope)) {
      throw new Error("Legacy and canonical account stores disagree; refusing ambiguous account migration");
    }
    if (existing === null) await this.#storage.put("default", legacy.envelope);
    if (legacy.recoveryEnvelope) await this.#storage.put("recovery:default", legacy.recoveryEnvelope);
    if (legacy.recoveryKeystore) await this.#storage.put("recovery-keystore:default", legacy.recoveryKeystore);
    await this.#bootstrap.addAccount("default", legacy.label);
    if (legacy.accountId) await this.#bootstrap.setAccountIdHint("default", legacy.accountId);
    await this.#storage.put("avatar:default", legacy.avatar.avatarFileHash);
    await this.#storage.put("avatarData:default", legacy.avatar.avatarDataB64);
    const migrated = await this.#bootstrap.getKeystoreStore("default").getKeystoreEnvelope();
    if (JSON.stringify(migrated) !== JSON.stringify(legacy.envelope)) {
      throw new Error("Canonical account migration could not be verified");
    }
    await legacyStore.delete("account");
  }
  dispatch(request) {
    if (!(request instanceof MobileHostRequestV1)) throw new Error("MobileHostRequestV1 required");
    this.#lifecycleBarrier = null;
    const pending = this.#tail.then(() => this.#dispatch(request));
    this.#tail = pending.catch((error) => console.error("Mobile host response failed", error));
    return pending;
  }
  async #dispatch(request) {
    try {
      await this.#ready;
      const raw = JSON.parse(request.paramsJson);
      const op = request.operation;
      let result = null;
      if (op.startsWith("bus:")) result = await this.#runtime.call(op.slice(4), raw);
      else if (op === "runtime.connect") {
        result = await this.#runtime.connect(this.#requireAccount());
        await this.#runtime.lifecycle("onForeground");
      } else if (op === "runtime.disconnect") await this.#runtime.disconnect();
      else if (op === "vault.status") result = await this.#status();
      else if (op === "vault.listAccounts") result = await this.#listAccounts();
      else if (op === "vault.getActiveIdentitySummary") result = this.#summary();
      else if (op === "vault.lock") {
        await this.#runtime.disconnect();
        await this.#auth.logout();
        result = await this.#status();
      } else if (op === "vault.revealMnemonic") {
        const revealed = await this.#auth.revealMnemonic(new MobileAuthParamsV1(raw));
        result = new MobileMnemonicResultV1(revealed.mnemonic);
      } else if (op.startsWith("vault.") && MOBILE_PROFILE_OPERATIONS.includes(op.slice(6))) {
        result = await this.#profile(op.slice(6), new MobileProfileParamsV1(raw));
      } else if (op.startsWith("vault.") && MOBILE_AUTH_MUTATIONS.includes(op.slice(6))) {
        await this.#runtime.disconnect();
        result = await this.#mutateAuth(op.slice(6), new MobileAuthParamsV1(raw));
      } else throw new Error("This host operation is unavailable");
      this.#emit(new MobileHostResponseV1(request.id, result));
    } catch (error) {
      this.#emit(new MobileHostResponseV1(request.id, null, error));
    }
  }
  async #status() {
    return new MobileVaultStatusV1((await this.#bootstrap.listAccounts()).length > 0, this.#auth.getAccount() !== null);
  }
  async #listAccounts() {
    const accounts = await this.#bootstrap.listAccounts();
    const decorated = [];
    for (const account of accounts) {
      const recovery = this.#bootstrap.getRecoveryStore(account.id);
      const recoveryEnabled = recovery !== null && await recovery.hasKeystore();
      decorated.push({ ...account, recoveryEnabled, delegated: !recoveryEnabled });
    }
    return new MobileAccountListV1(decorated);
  }
  #requireAccount() {
    const account = this.#auth.getAccount();
    if (!account) throw new Error("Unlock Rez Chat first");
    return account;
  }
  #summary() {
    const account = this.#auth.getAccount();
    return account ? new MobileIdentitySummaryV1(account, this.#session.selfLabel()) : null;
  }
  async #mutateAuth(operation, params) {
    if (operation === "unlock") await this.#auth.unlock(params);
    else if (operation === "createAccount") await this.#auth.createAccount(params);
    else if (operation === "linkDevice") await this.#auth.linkDevice(params);
    else if (operation === "restoreWithMnemonic") await this.#auth.restoreWithMnemonic(params);
    else if (operation === "changePassword") {
      await this.#auth.changePassword(params);
      return this.#status();
    } else if (operation === "resetPasswordWithMnemonic") {
      await this.#auth.resetPasswordWithMnemonic(params);
      return this.#status();
    } else throw new Error("Unknown account operation");
    return this.#summary();
  }
  async #profile(operation, params) {
    const storeKey = this.#bootstrap.resolveAccountKey(params.accountId);
    if (operation === "getAvatarFileHash") {
      return new MobileAvatarV1({ avatarFileHash: await this.#bootstrap.getAvatarFileHash(storeKey) });
    }
    if (operation === "getAvatarDataB64") {
      return new MobileAvatarV1({ avatarDataB64: await this.#bootstrap.getAvatarDataB64(storeKey) });
    }
    const account = this.#requireAccount();
    if (operation === "setProfileName") {
      const name = params.profileName.trim();
      if (!name) throw new Error("Display name is required");
      await this.#bootstrap.setDisplayName(storeKey, name);
      account.profileName = name;
      return this.#summary();
    }
    if (operation === "setAvatarFileHash") await this.#bootstrap.setAvatarFileHash(storeKey, params.avatarFileHash);
    else if (operation === "setAvatarDataB64") await this.#bootstrap.setAvatarDataB64(storeKey, params.avatarDataB64);
    else throw new Error("Unknown profile operation");
    return new MobileAvatarV1({
      avatarFileHash: await this.#bootstrap.getAvatarFileHash(storeKey),
      avatarDataB64: await this.#bootstrap.getAvatarDataB64(storeKey),
    });
  }
  lifecycle(request) {
    if (!(request instanceof MobileLifecycleRequestV1)) throw new Error("MobileLifecycleRequestV1 required");
    if (request.name === "onForeground") this.#accountSockets.foreground();
    if (request.name === "onBackground") return this.#background(request);
    if (this.#lifecycleBarrier === null) this.#lifecycleBarrier = this.#tail;
    const pending = this.#lifecycleBarrier.then(async () => {
      let report = null;
      let failure = null;
      try { report = await this.#runtime.lifecycle(request.name); }
      catch (error) { failure = error; }
      this.#emit(new MobileLifecycleResultV1(request, report, failure));
    });
    this.#tail = Promise.all([this.#tail, pending]).then(() => undefined)
      .catch((error) => console.error("Mobile lifecycle failed", error));
    return pending;
  }
  async #background(request) {
    let failure = null;
    try {
      this.#accountSockets.background();
      const report = await this.#runtime.lifecycle("onBackground");
      if (report && report.reason === "suspend-failed") throw new Error("Account-control suspension failed");
    } catch (error) { failure = error; }
    this.#emit(new MobileLifecycleResultV1(request, new MobileBackgroundReportV1(), failure));
  }
}

export function installMobileApplication(rawConfig, emit) {
  const primitive = installNativePlatform(globalThis.__rezNativeInvoke);
  const host = new MobileApplicationHost(new MobileHostConfigV1(rawConfig), primitive, (record) => emit(JSON.stringify(record.toJSON())));
  globalThis.__rezMobileRequest = (json) => host.dispatch(new MobileHostRequestV1(JSON.parse(json)));
  globalThis.__rezMobileLifecycle = (json) => host.lifecycle(new MobileLifecycleRequestV1(JSON.parse(json)));
  return host;
}
