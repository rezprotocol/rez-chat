import {
  createKeystoreAccount,
  deriveBrowserAccountRecovery,
  generateBrowserMnemonic,
  openBrowserRecoveryMnemonic,
  sealBrowserRecoveryMnemonic,
  resealKeystoreEnvelope,
  IndexedDbStorageProvider,
  unlockKeystoreAccount,
} from "@rezprotocol/sdk/client";
import { SESSION_STATUS } from "../../stores/SessionStore.js";
import { nonEmptyString } from "../../../records/index.js";
import { browserChatRuntimeDbName } from "../../../client/runtime/browserRuntimeStorage.js";

export class AccountAuthService {
  constructor({
    sessionStore,
    authBootstrapService,
    cryptoProvider = null,
    logger = console,
  } = {}) {
    if (!sessionStore || !authBootstrapService) {
      throw new Error("AccountAuthService requires sessionStore and authBootstrapService");
    }
    this._sessionStore = sessionStore;
    this._authBootstrapService = authBootstrapService;
    this._cryptoProvider = cryptoProvider;
    this._logger = logger;
    this._account = null;
    this._pendingServerSyncEnvelope = null;
  }

  getAccount() {
    return this._account;
  }

  runtimeDisconnectMustSucceed() {
    return true;
  }

  takePendingServerSyncEnvelope() {
    const envelope = this._pendingServerSyncEnvelope;
    this._pendingServerSyncEnvelope = null;
    return envelope;
  }

  async createAccount({ password = "", profileName = "", localOnly = false } = {}) {
    const pwd = String(password || "");
    const name = nonEmptyString(profileName);
    if (!name) throw new Error("Enter a name to create an account.");
    if (!pwd) throw new Error("Enter a password.");
    if (pwd.length < 8) throw new Error("Password must be at least 8 characters.");

    if (this._authBootstrapService.hasLegacyStore()) {
      const legacyStore = this._authBootstrapService.getKeystoreStore(this._authBootstrapService.defaultAccountKey);
      const hasLegacy = await legacyStore.hasKeystore();
      if (hasLegacy) throw new Error("Keystore already exists. Unlock with your password.");
      await createKeystoreAccount({
        password: pwd,
        profileName: name,
        keystoreStore: legacyStore,
        cryptoProvider: this._cryptoProvider,
      });
      return this.unlock({ accountId: this._authBootstrapService.defaultAccountKey, password: pwd });
    }

    const list = await this._authBootstrapService.listAccounts();
    const accountId = list.length === 0 ? this._authBootstrapService.defaultAccountKey : `account-${Date.now()}`;
    const store = this._authBootstrapService.getKeystoreStore(accountId);
    const has = await store.hasKeystore();
    if (has) throw new Error("Account already exists. Unlock with your password.");

    const recoveryStore = this._authBootstrapService.getRecoveryStore(accountId);
    if (!recoveryStore) throw new Error("Browser account recovery storage is unavailable");
    const mnemonic = await generateBrowserMnemonic({ words: 24 });
    const recovery = await deriveBrowserAccountRecovery(mnemonic);
    const recoveryEnvelope = await sealBrowserRecoveryMnemonic({
      mnemonic,
      password: pwd,
      cryptoProvider: this._cryptoProvider,
    });
    await recoveryStore.putKeystoreEnvelope(recoveryEnvelope);
    let registryAdded = false;
    try {
      await createKeystoreAccount({
        password: pwd,
        profileName: name,
        keystoreStore: store,
        cryptoProvider: this._cryptoProvider,
        identity: recovery.identity,
      });
      await this._authBootstrapService.addAccount(accountId, name);
      registryAdded = true;
    } catch (err) {
      await this._cleanupFailedBrowserAccount(accountId, store, recoveryStore, registryAdded);
      throw err;
    }

    if (localOnly) {
      await this._authBootstrapService.setLocalOnlyKeystoreSync(accountId, true);
    }

    const result = await this.unlock({ accountId, password: pwd });
    this._sessionStore.setAccountList(await this._authBootstrapService.listAccounts());
    return result;
  }

  async unlock({ accountId = null, password = "" } = {}) {
    const pwd = String(password || "").trim();
    if (!pwd) throw new Error("Enter your password to unlock.");

    const snap = this._sessionStore.snapshot();
    const accountList = Array.isArray(snap.accountList) ? snap.accountList : [];
    const resolvedId =
      accountId != null && String(accountId).trim() !== ""
        ? String(accountId).trim()
        : (snap.selectedAccountId || (accountList[0] && accountList[0].id) || this._authBootstrapService.defaultAccountKey);

    const accountEntry = accountList.find((entry) => entry.id === resolvedId);
    const cryptoAccountId = accountEntry && accountEntry.accountIdHint ? String(accountEntry.accountIdHint).trim() : "";
    const isLocalOnly = await this._authBootstrapService.getLocalOnlyKeystoreSync(resolvedId);
    const store = this._authBootstrapService.getKeystoreStore(resolvedId);
    const envelope = await store.getKeystoreEnvelope();
    if (!envelope) {
      this._sessionStore.setNoKeystore();
      throw new Error("No keystore found for this account. Create an account first.");
    }

    this._sessionStore.setUnlocking();

    try {
      const account = await unlockKeystoreAccount({
        password: pwd,
        keystoreStore: store,
        cryptoProvider: this._cryptoProvider,
      });
      const recoveryStore = this._authBootstrapService.getRecoveryStore(resolvedId);
      if (recoveryStore && await recoveryStore.hasKeystore()) {
        const recoveryEnvelope = await recoveryStore.getKeystoreEnvelope();
        const mnemonic = await openBrowserRecoveryMnemonic({
          envelope: recoveryEnvelope,
          password: pwd,
          cryptoProvider: this._cryptoProvider,
        });
        const recovery = await deriveBrowserAccountRecovery(mnemonic);
        if (recovery.identity.getAccountId() !== account.accountId) {
          throw new Error("Recovery phrase does not match unlocked account");
        }
        account.accountIdentityDhKeyPair = recovery.accountIdentityDhKeyPair;
      }
      this._account = account;

      const unlockedAccountId = String(account.accountId || "").trim();
      const deviceId = String(account.deviceId || "").trim();

      if (!unlockedAccountId || !deviceId) {
        throw new Error("Decrypted account missing identity (accountId/deviceId)");
      }

      this._sessionStore.setUnlocked({
        accountId: unlockedAccountId,
        deviceId,
      });
      this._sessionStore.setSelectedAccountId(resolvedId);

      if (this._authBootstrapService.hasAccountRegistry() && unlockedAccountId) {
        await this._authBootstrapService.setAccountIdHint(resolvedId, unlockedAccountId);
      }

      if (!isLocalOnly) {
        this._pendingServerSyncEnvelope = envelope;
      } else {
        this._pendingServerSyncEnvelope = null;
      }

      if (cryptoAccountId && cryptoAccountId !== unlockedAccountId && this._logger && typeof this._logger.warn === "function") {
        this._logger.warn("Stored accountId hint did not match unlocked keystore accountId", {
          selectedAccountId: resolvedId,
          expected: cryptoAccountId,
          actual: unlockedAccountId,
        });
      }

      return { accountId: unlockedAccountId, deviceId };
    } catch (err) {
      const message = this._normalizeError(err, "Unlock failed.");
      this._sessionStore.setLocked({ error: message });
      throw new Error(message);
    }
  }

  async logout() {
    const snap = this._sessionStore.snapshot();
    if (snap.status === SESSION_STATUS.NO_KEYSTORE) {
      this._sessionStore.setNoKeystore();
      return;
    }

    this._sessionStore.setLocking();
    this._account = null;
    this._pendingServerSyncEnvelope = null;

    const selectedId =
      snap.selectedAccountId ||
      (Array.isArray(snap.accountList) && snap.accountList[0] && snap.accountList[0].id ? snap.accountList[0].id : null) ||
      this._authBootstrapService.defaultAccountKey;

    const store = this._authBootstrapService.getKeystoreStore(selectedId);
    const envelope = await store.getKeystoreEnvelope();
    if (this._authBootstrapService.hasAccountRegistry()) {
      const list = await this._authBootstrapService.listAccounts();
      this._sessionStore.setAccountList(list);
    }
    if (envelope) {
      this._sessionStore.setLocked({});
    } else {
      this._sessionStore.setNoKeystore();
    }
  }

  async revealMnemonic({ accountId = null, password = "" } = {}) {
    const pwd = String(password || "");
    if (!pwd) throw new Error("Enter your password to reveal the recovery phrase.");
    const storeKey = this._resolveStoreKey(accountId);
    const recoveryStore = this._authBootstrapService.getRecoveryStore(storeKey);
    if (!recoveryStore || !(await recoveryStore.hasKeystore())) {
      throw new Error("This account predates browser recovery. Export it from a primary device before relying on this browser.");
    }
    const mainStore = this._authBootstrapService.getKeystoreStore(storeKey);
    await unlockKeystoreAccount({
      password: pwd,
      keystoreStore: mainStore,
      cryptoProvider: this._cryptoProvider,
    });
    const mnemonic = await openBrowserRecoveryMnemonic({
      envelope: await recoveryStore.getKeystoreEnvelope(),
      password: pwd,
      cryptoProvider: this._cryptoProvider,
    });
    return { mnemonic };
  }

  async restoreWithMnemonic({ mnemonic = "", newPassword = "", profileName = "" } = {}) {
    const pwd = String(newPassword || "");
    const name = nonEmptyString(profileName) || "Recovered account";
    if (pwd.length < 8) throw new Error("New password must be at least 8 characters.");
    if (this._authBootstrapService.hasLegacyStore()) {
      throw new Error("Recovery phrase restore requires browser account storage.");
    }
    const recovery = await deriveBrowserAccountRecovery(mnemonic);
    const accounts = await this._authBootstrapService.listAccounts();
    const existing = accounts.find((entry) => entry && entry.accountIdHint === recovery.identity.getAccountId());
    if (existing) throw new Error("This account identity already exists in this browser.");
    const storeKey = accounts.length === 0
      ? this._authBootstrapService.defaultAccountKey
      : `account-${Date.now()}`;
    const mainStore = this._authBootstrapService.getKeystoreStore(storeKey);
    const recoveryStore = this._authBootstrapService.getRecoveryStore(storeKey);
    if (!recoveryStore) throw new Error("Browser account recovery storage is unavailable");
    if (await mainStore.hasKeystore()) throw new Error("Account storage slot already exists.");
    const recoveryEnvelope = await sealBrowserRecoveryMnemonic({
      mnemonic,
      password: pwd,
      cryptoProvider: this._cryptoProvider,
    });
    await recoveryStore.putKeystoreEnvelope(recoveryEnvelope);
    let registryAdded = false;
    try {
      await createKeystoreAccount({
        password: pwd,
        profileName: name,
        keystoreStore: mainStore,
        cryptoProvider: this._cryptoProvider,
        identity: recovery.identity,
      });
      await this._authBootstrapService.addAccount(storeKey, name);
      registryAdded = true;
      await this._authBootstrapService.setAccountIdHint(storeKey, recovery.identity.getAccountId());
    } catch (err) {
      await this._cleanupFailedBrowserAccount(storeKey, mainStore, recoveryStore, registryAdded);
      throw err;
    }
    const result = await this.unlock({ accountId: storeKey, password: pwd });
    this._sessionStore.setAccountList(await this._authBootstrapService.listAccounts());
    return result;
  }

  async changePassword({ accountId = null, oldPassword = "", newPassword = "" } = {}) {
    const oldPwd = String(oldPassword || "");
    const newPwd = String(newPassword || "");
    if (!oldPwd) throw new Error("Enter your current password.");
    if (newPwd.length < 8) throw new Error("New password must be at least 8 characters.");
    if (oldPwd === newPwd) throw new Error("New password must differ from the current password.");
    const storeKey = this._resolveStoreKey(accountId);
    const mainStore = this._authBootstrapService.getKeystoreStore(storeKey);
    const recoveryStore = this._authBootstrapService.getRecoveryStore(storeKey);
    if (!recoveryStore || !(await recoveryStore.hasKeystore())) {
      throw new Error("This browser account has no recovery envelope and cannot change passwords safely.");
    }
    const mainEnvelope = await mainStore.getKeystoreEnvelope();
    const recoveryEnvelope = await recoveryStore.getKeystoreEnvelope();
    const mnemonic = await openBrowserRecoveryMnemonic({
      envelope: recoveryEnvelope,
      password: oldPwd,
      cryptoProvider: this._cryptoProvider,
    });
    const nextMainEnvelope = await resealKeystoreEnvelope({
      envelope: mainEnvelope,
      oldPassword: oldPwd,
      newPassword: newPwd,
      cryptoProvider: this._cryptoProvider,
    });
    const nextRecoveryEnvelope = await sealBrowserRecoveryMnemonic({
      mnemonic,
      password: newPwd,
      cryptoProvider: this._cryptoProvider,
    });

    await recoveryStore.putKeystoreEnvelope(nextRecoveryEnvelope);
    try {
      await mainStore.putKeystoreEnvelope(nextMainEnvelope);
    } catch (err) {
      try {
        await recoveryStore.putKeystoreEnvelope(recoveryEnvelope);
      } catch (rollbackErr) {
        if (this._logger && typeof this._logger.error === "function") {
          this._logger.error("Browser password-change rollback failed", rollbackErr);
        }
      }
      throw err;
    }
    const rootAccountId = this._account && this._account.accountId ? String(this._account.accountId) : "";
    await this.logout();
    return { accountId: rootAccountId };
  }

  async purgeAccount({ accountId = null, password = "" } = {}) {
    const pwd = String(password || "");
    if (!pwd) throw new Error("Enter your password to delete this account.");
    const storeKey = this._resolveStoreKey(accountId);
    const mainStore = this._authBootstrapService.getKeystoreStore(storeKey);
    const account = await unlockKeystoreAccount({
      password: pwd,
      keystoreStore: mainStore,
      cryptoProvider: this._cryptoProvider,
    });
    const recoveryStore = this._authBootstrapService.getRecoveryStore(storeKey);
    if (globalThis.indexedDB && typeof globalThis.indexedDB.open === "function") {
      const runtimeStorage = new IndexedDbStorageProvider({
        dbName: browserChatRuntimeDbName(account.accountId),
        storeName: "runtime",
      });
      await runtimeStorage.clear();
    }
    await mainStore.clearKeystore();
    if (recoveryStore) await recoveryStore.clearKeystore();
    await this._authBootstrapService.deleteAccountMetadata(storeKey);
    await this._authBootstrapService.removeAccount(storeKey);
    this._account = null;
    this._pendingServerSyncEnvelope = null;
    const accounts = await this._authBootstrapService.listAccounts();
    this._sessionStore.setAccountList(accounts);
    if (accounts.length === 0) this._sessionStore.setNoKeystore();
    else {
      this._sessionStore.setSelectedAccountId(accounts[0].id);
      this._sessionStore.setLocked({});
    }
    return { accountId: account.accountId, deleted: true };
  }

  _resolveStoreKey(accountId = null) {
    const explicit = String(accountId == null ? "" : accountId).trim();
    const snapshot = this._sessionStore.snapshot();
    const selected = snapshot && snapshot.selectedAccountId ? String(snapshot.selectedAccountId).trim() : "";
    const accounts = snapshot && Array.isArray(snapshot.accountList) ? snapshot.accountList : [];
    const explicitEntry = accounts.find((entry) => entry && (entry.id === explicit || entry.accountIdHint === explicit));
    if (explicitEntry && explicitEntry.id) return String(explicitEntry.id);
    if (explicit) return explicit;
    if (selected) return selected;
    return this._authBootstrapService.defaultAccountKey;
  }

  async _cleanupFailedBrowserAccount(storeKey, mainStore, recoveryStore, registryAdded) {
    const cleanupTasks = [
      ["main keystore", () => mainStore.clearKeystore()],
      ["recovery envelope", () => recoveryStore.clearKeystore()],
    ];
    if (registryAdded) {
      cleanupTasks.push(["account registry", () => this._authBootstrapService.removeAccount(storeKey)]);
    }
    for (const task of cleanupTasks) {
      try {
        await task[1]();
      } catch (cleanupErr) {
        if (this._logger && typeof this._logger.error === "function") {
          this._logger.error(`Browser account cleanup failed for ${task[0]}`, cleanupErr);
        }
      }
    }
  }

  _normalizeError(err, fallback) {
    const message = String(err && err.message ? err.message : "").trim();
    if (!message) return fallback;
    if (message.includes("decrypt") || message.includes("AES-GCM") || message.includes("mismatch")) {
      return "Invalid password.";
    }
    return message;
  }
}
