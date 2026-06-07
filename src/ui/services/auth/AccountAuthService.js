import { createKeystoreAccount, unlockKeystoreAccount } from "@rezprotocol/sdk/client";
import { SESSION_STATUS } from "../../stores/SessionStore.js";
import { nonEmptyString } from "../../../records/index.js";

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
    await this._authBootstrapService.addAccount(accountId, name);
    const store = this._authBootstrapService.getKeystoreStore(accountId);
    const has = await store.hasKeystore();
    if (has) throw new Error("Account already exists. Unlock with your password.");

    await createKeystoreAccount({
      password: pwd,
      profileName: name,
      keystoreStore: store,
      cryptoProvider: this._cryptoProvider,
    });

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
    const envelope = await store.getKeystoreEnvelope().catch(() => null);
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

  _normalizeError(err, fallback) {
    const message = String(err && err.message ? err.message : "").trim();
    if (!message) return fallback;
    if (message.includes("decrypt") || message.includes("AES-GCM") || message.includes("mismatch")) {
      return "Invalid password.";
    }
    return message;
  }
}
