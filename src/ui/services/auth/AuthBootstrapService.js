import { KeystoreStore } from "@rezprotocol/sdk/client";
import { AUTH_STATUS } from "../../stores/AuthStore.js";
import { AccountRegistryData } from "../../records/AccountRegistryData.js";
import { AuthBootstrapDiagnosticResult } from "../../records/AuthBootstrapDiagnosticResult.js";

const DEFAULT_ACCOUNT_KEY = "default";
const KEYSTORE_LOCAL_ONLY_PREF_KEY = "keystoreLocalOnly";
const REGISTRY_KEY = "rez:account-hints";

function countObjectKeys(value) {
  if (!value || typeof value !== "object") return 0;
  return Object.keys(value).length;
}

function keystoreMeta(envelope) {
  if (!envelope) return null;
  return {
    version: Number(envelope.version || 0),
    updatedAtMs: Number(envelope.updatedAtMs || 0) || null,
  };
}

function createKeystoreStoreForAccount(storageProvider, accountId) {
  return new KeystoreStore({ storageProvider, key: String(accountId || DEFAULT_ACCOUNT_KEY) });
}

export class AuthBootstrapService {
  constructor({
    authStore,
    storageProvider = null,
    accountRegistry = null,
    keystoreStore = null,
    logger = console,
  } = {}) {
    if (!authStore) throw new Error("AuthBootstrapService requires authStore");
    const hasStorage = storageProvider && typeof storageProvider.get === "function" && typeof storageProvider.put === "function";
    const hasRegistry = accountRegistry && typeof accountRegistry.listAccounts === "function";
    const hasLegacyStore = keystoreStore instanceof KeystoreStore;
    if (!hasStorage && !hasRegistry && !hasLegacyStore) {
      throw new Error("AuthBootstrapService requires storageProvider+accountRegistry or a KeystoreStore instance");
    }
    this._authStore = authStore;
    this._storageProvider = storageProvider;
    this._accountRegistry = accountRegistry;
    this._keystoreStoreLegacy = hasLegacyStore ? keystoreStore : null;
    this._logger = logger;
  }

  get defaultAccountKey() {
    return DEFAULT_ACCOUNT_KEY;
  }

  hasLegacyStore() {
    return this._keystoreStoreLegacy instanceof KeystoreStore;
  }

  hasAccountRegistry() {
    return !!(this._accountRegistry && typeof this._accountRegistry.listAccounts === "function");
  }

  getKeystoreStore(accountId) {
    if (this._keystoreStoreLegacy) {
      return this._keystoreStoreLegacy;
    }
    return createKeystoreStoreForAccount(this._storageProvider, accountId);
  }

  async listAccounts() {
    if (this._keystoreStoreLegacy) {
      const has = await this._keystoreStoreLegacy.hasKeystore();
      if (!has) return [];
      return [{ id: DEFAULT_ACCOUNT_KEY, label: "Account", accountIdHint: null }];
    }
    if (!this._accountRegistry) return [];
    return this._accountRegistry.listAccounts();
  }

  selectAccount({ accountId } = {}) {
    const id = accountId != null ? String(accountId).trim() : "";
    if (!id) return false;
    const snap = this._authStore.snapshot();
    const list = Array.isArray(snap.accountList) ? snap.accountList : [];
    const found = list.some((account) => account.id === id);
    if (!found) return false;
    this._authStore.setSelectedAccountId(id);
    return true;
  }

  async init() {
    if (this._keystoreStoreLegacy) {
      const has = await this._keystoreStoreLegacy.hasKeystore();
      if (!has) {
        this._authStore.setNoKeystore();
        return this._authStore.snapshot();
      }
      const envelope = await this._keystoreStoreLegacy.getKeystoreEnvelope();
      this._authStore.setAccountList([{ id: DEFAULT_ACCOUNT_KEY, label: "Account", accountIdHint: null }]);
      this._authStore.setSelectedAccountId(DEFAULT_ACCOUNT_KEY);
      this._authStore.setLocked({ keystoreMeta: keystoreMeta(envelope) });
      return this._authStore.snapshot();
    }

    let list = await this.listAccounts();
    if (list.length === 0 && this._accountRegistry) {
      const discovered = await this._rehydrateRegistryFromLocalKeystores();
      if (discovered.length > 0) {
        list = await this.listAccounts();
      }
    }
    if (list.length === 0) {
      const defaultStore = createKeystoreStoreForAccount(this._storageProvider, DEFAULT_ACCOUNT_KEY);
      const hasDefault = await defaultStore.hasKeystore();
      if (hasDefault && this._accountRegistry) {
        await this._accountRegistry.addAccount(DEFAULT_ACCOUNT_KEY, "Account");
        const after = await this.listAccounts();
        this._authStore.setAccountList(after);
        const envelope = await defaultStore.getKeystoreEnvelope();
        this._authStore.setLocked({ keystoreMeta: keystoreMeta(envelope) });
        return this._authStore.snapshot();
      }
      this._authStore.setNoKeystore();
      await this._logBootstrapDiagnosticIfNeeded();
      return this._authStore.snapshot();
    }

    this._authStore.setAccountList(list);
    if (list.length === 1) {
      this._authStore.setSelectedAccountId(list[0].id);
    }
    const firstId = list[0] && list[0].id ? list[0].id : DEFAULT_ACCOUNT_KEY;
    const store = this.getKeystoreStore(firstId);
    const envelope = await store.getKeystoreEnvelope().catch(() => null);
    this._authStore.setLocked({ keystoreMeta: envelope ? keystoreMeta(envelope) : null });
    await this._logBootstrapDiagnosticIfNeeded();
    return this._authStore.snapshot();
  }

  async inspectBootstrap() {
    const result = await this._buildBootstrapDiagnosticResult();
    if (this._logger && typeof this._logger.info === "function") {
      this._logger.info("[rez-chat][auth] bootstrap diagnostic", result.toJSON());
    }
    return result;
  }

  async addAccount(id, label) {
    if (!this._accountRegistry) {
      throw new Error("AuthBootstrapService addAccount requires accountRegistry");
    }
    return this._accountRegistry.addAccount(id, label);
  }

  async setAccountIdHint(id, accountIdHint) {
    if (!this._accountRegistry) return null;
    return this._accountRegistry.setAccountIdHint(id, accountIdHint);
  }

  async setDisplayName(accountId, displayName) {
    if (!this._accountRegistry) return;
    const id = String(accountId != null ? accountId : "").trim();
    if (!id) return;
    await this._accountRegistry.setAccountLabel(id, displayName != null ? displayName : "");
    const list = await this.listAccounts();
    this._authStore.setAccountList(list);
  }

  async setAvatarFileHash(accountId, hash) {
    if (!this._storageProvider) return;
    const id = String(accountId != null ? accountId : "").trim();
    if (!id) return;
    try {
      await this._storageProvider.put("avatar:" + id, typeof hash === "string" ? hash : "");
    } catch (err) {
      if (this._logger && typeof this._logger.warn === "function") {
        this._logger.warn("Failed to save avatar hash", err && err.message ? err.message : err);
      }
    }
  }

  async getAvatarFileHash(accountId) {
    if (!this._storageProvider) return "";
    const id = String(accountId != null ? accountId : "").trim();
    if (!id) return "";
    try {
      const value = await this._storageProvider.get("avatar:" + id);
      return typeof value === "string" ? value : "";
    } catch (err) {
      if (this._logger && typeof this._logger.warn === "function") {
        this._logger.warn("Failed to read avatar hash", err && err.message ? err.message : err);
      }
      return "";
    }
  }

  async setAvatarDataB64(accountId, dataB64) {
    if (!this._storageProvider) return;
    const id = String(accountId != null ? accountId : "").trim();
    if (!id) return;
    try {
      await this._storageProvider.put("avatarData:" + id, typeof dataB64 === "string" ? dataB64 : "");
    } catch (err) {
      if (this._logger && typeof this._logger.warn === "function") {
        this._logger.warn("Failed to save avatar data", err && err.message ? err.message : err);
      }
    }
  }

  async getAvatarDataB64(accountId) {
    if (!this._storageProvider) return "";
    const id = String(accountId != null ? accountId : "").trim();
    if (!id) return "";
    try {
      const value = await this._storageProvider.get("avatarData:" + id);
      return typeof value === "string" ? value : "";
    } catch (err) {
      if (this._logger && typeof this._logger.warn === "function") {
        this._logger.warn("Failed to read avatar data", err && err.message ? err.message : err);
      }
      return "";
    }
  }

  async getLocalOnlyKeystoreSync(storeKey) {
    if (!this._storageProvider) return false;
    try {
      const value = await this._storageProvider.get(`${KEYSTORE_LOCAL_ONLY_PREF_KEY}:${storeKey}`);
      return value === true;
    } catch {
      return false;
    }
  }

  async setLocalOnlyKeystoreSync(storeKey, enabled) {
    if (!this._storageProvider) return;
    try {
      await this._storageProvider.put(`${KEYSTORE_LOCAL_ONLY_PREF_KEY}:${storeKey}`, enabled === true);
    } catch (err) {
      if (this._logger && typeof this._logger.warn === "function") {
        this._logger.warn("Failed to save local-only keystore pref", err && err.message ? err.message : err);
      }
    }
  }

  async _logBootstrapDiagnosticIfNeeded() {
    const result = await this._buildBootstrapDiagnosticResult();
    const diagnostic = result.diagnostic;
    const status = this._authStore.snapshot().status;
    const shouldLog =
      status === AUTH_STATUS.NO_KEYSTORE ||
      (diagnostic && Array.isArray(diagnostic.orphanEnvelopeKeys) && diagnostic.orphanEnvelopeKeys.length > 0);
    if (!shouldLog) return;
    if (this._logger && typeof this._logger.warn === "function") {
      this._logger.warn("[rez-chat][auth] bootstrap state", result.toJSON());
    }
  }

  async _buildBootstrapDiagnosticResult() {
    const storageKeys = await this._listStorageKeys();
    const discoveredEnvelopeKeys = await this._discoverLocalKeystoreKeys(storageKeys);
    const registryRaw = await this._getRegistryRaw();
    let registry;
    try {
      registry = new AccountRegistryData(registryRaw);
    } catch {
      registry = new AccountRegistryData({});
    }
    const registryAccountIds = Array.isArray(registry.accountIds) ? registry.accountIds : [];
    const orphanEnvelopeKeys = discoveredEnvelopeKeys.filter((key) => !registryAccountIds.includes(key));
    const defaultEnvelopePresent = discoveredEnvelopeKeys.includes(DEFAULT_ACCOUNT_KEY);
    const storageProvider = this._storageProvider;
    const dbName = storageProvider && typeof storageProvider.getDbName === "function" ? storageProvider.getDbName() : "";
    const storeName = storageProvider && typeof storageProvider.getStoreName === "function" ? storageProvider.getStoreName() : "";
    const snap = this._authStore.snapshot();
    let reason = "";
    if (registryAccountIds.length === 0 && orphanEnvelopeKeys.length > 0) {
      reason = "Valid local keystore envelopes exist, but the account registry is empty.";
    } else if (registryAccountIds.length > 0 && discoveredEnvelopeKeys.length === 0) {
      reason = "Account registry exists, but no valid local keystore envelopes were found for those keys.";
    } else if (snap.status === AUTH_STATUS.NO_KEYSTORE) {
      reason = "No local keystore envelope was discovered for the selected browser storage.";
    }
    return new AuthBootstrapDiagnosticResult({
      diagnostic: {
        storageKind: storageProvider ? storageProvider.constructor && storageProvider.constructor.name ? storageProvider.constructor.name : "storageProvider" : "",
        dbName,
        storeName,
        storageKeys,
        registryPresent: registryRaw != null,
        registryAccountIds,
        registryHintsCount: countObjectKeys(registry.hints),
        defaultEnvelopePresent,
        discoveredEnvelopeKeys,
        orphanEnvelopeKeys,
        selectedAccountId: snap && snap.selectedAccountId ? String(snap.selectedAccountId) : "",
        resolvedStatus: snap && snap.status ? String(snap.status) : "",
        reason,
      },
    });
  }

  async _rehydrateRegistryFromLocalKeystores() {
    if (!this._accountRegistry) return [];
    const discoveredEnvelopeKeys = await this._discoverLocalKeystoreKeys();
    if (discoveredEnvelopeKeys.length === 0) return [];
    const registry = await this._accountRegistry.getRegistry();
    let changed = false;
    for (const key of discoveredEnvelopeKeys) {
      if (!registry.accountIds.includes(key)) {
        registry.accountIds.push(key);
        changed = true;
      }
      const hint = registry.hints && typeof registry.hints[key] === "object" ? registry.hints[key] : null;
      const label = hint && typeof hint.label === "string" ? hint.label.trim() : "";
      if (!hint || !label) {
        registry.hints[key] = Object.assign({}, hint || {}, {
          label: key === DEFAULT_ACCOUNT_KEY ? "Account" : key,
        });
        changed = true;
      }
    }
    if (changed) {
      await this._accountRegistry.setRegistry(registry);
    }
    return discoveredEnvelopeKeys;
  }

  async _getRegistryRaw() {
    if (!this._storageProvider || typeof this._storageProvider.get !== "function") return null;
    try {
      return await this._storageProvider.get(REGISTRY_KEY);
    } catch {
      return null;
    }
  }

  async _listStorageKeys() {
    if (!this._storageProvider || typeof this._storageProvider.listKeys !== "function") return [];
    try {
      const keys = await this._storageProvider.listKeys();
      return Array.isArray(keys) ? keys : [];
    } catch {
      return [];
    }
  }

  _isReservedStorageKey(key) {
    const normalizedKey = String(key || "").trim();
    if (!normalizedKey) return true;
    if (normalizedKey === REGISTRY_KEY) return true;
    if (normalizedKey.indexOf(KEYSTORE_LOCAL_ONLY_PREF_KEY + ":") === 0) return true;
    if (normalizedKey.indexOf("avatar:") === 0) return true;
    if (normalizedKey.indexOf("avatarData:") === 0) return true;
    return false;
  }

  async _discoverLocalKeystoreKeys(existingKeys = null) {
    const keys = Array.isArray(existingKeys) ? existingKeys : await this._listStorageKeys();
    const discovered = [];
    for (const key of keys) {
      if (this._isReservedStorageKey(key)) continue;
      const store = createKeystoreStoreForAccount(this._storageProvider, key);
      const envelope = await store.getKeystoreEnvelope().catch(() => null);
      if (envelope) {
        discovered.push(String(key));
      }
    }
    discovered.sort();
    return discovered;
  }
}
