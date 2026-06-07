import { SESSION_STATUS } from "../../stores/SessionStore.js";
import { coerceRow } from "../../../records/domain/coerce.js";
import { DesktopAccountListEntry } from "../../records/DesktopAccountListEntry.js";
import { DesktopVaultStatus } from "../../records/DesktopVaultStatus.js";

const DEFAULT_ACCOUNT_KEY = "desktop";

function getDesktopBridge() {
  const root = typeof globalThis !== "undefined" ? globalThis : {};
  const windowRef = root && root.window ? root.window : null;
  const bridge = root.rezDesktop || (windowRef && windowRef.rezDesktop) || null;
  return bridge && typeof bridge === "object" ? bridge : null;
}

function coerceAccountList(result) {
  const source = result && typeof result === "object" ? result : {};
  const accounts = Array.isArray(source.accounts)
    ? source.accounts
    : Array.isArray(result) ? result : [];
  return accounts
    .map((account) => coerceRow(DesktopAccountListEntry, account, { label: "DesktopAuthServices" }))
    .filter((entry) => entry !== null);
}

function applyActiveAccountLabel(accounts, active) {
  const activeAccountId = String(active && active.accountId ? active.accountId : "").trim();
  const profileName = String(active && active.profileName ? active.profileName : "").trim();
  if (!activeAccountId || !profileName) return accounts;
  return accounts.map((account) => {
    if (account.id !== activeAccountId && account.accountIdHint !== activeAccountId) return account;
    return new DesktopAccountListEntry({ ...account.toJSON(), label: profileName });
  });
}

export function hasDesktopRuntimeBridge() {
  const bridge = getDesktopBridge();
  return !!(
    bridge
    && bridge.vault
    && typeof bridge.vault.status === "function"
    && bridge.runtime
    && typeof bridge.runtime.connect === "function"
    && bridge.bus
    && typeof bridge.bus.call === "function"
  );
}

export class DesktopAuthBootstrapService {
  constructor({ sessionStore, desktop = null, logger = console } = {}) {
    if (!sessionStore) throw new Error("DesktopAuthBootstrapService requires sessionStore");
    this._sessionStore = sessionStore;
    this._desktop = desktop || getDesktopBridge();
    this._logger = logger;
  }

  get defaultAccountKey() {
    return DEFAULT_ACCOUNT_KEY;
  }

  hasLegacyStore() {
    return false;
  }

  hasAccountRegistry() {
    return true;
  }

  async init() {
    const status = new DesktopVaultStatus(await this._desktop.vault.status());
    const listed = await this.listAccounts();
    this._sessionStore.setAccountList(listed);
    if (listed.length > 0) this._sessionStore.setSelectedAccountId(listed[0].id);
    if (!status.hasAccounts) {
      this._sessionStore.setNoKeystore();
      return this._sessionStore.snapshot();
    }
    this._sessionStore.setLocked({});
    return this._sessionStore.snapshot();
  }

  async inspectBootstrap() {
    return {
      diagnostic: {
        storageKind: "ElectronDesktopVault",
        dbName: "desktop-vault.sqlite",
        storeName: "vault_accounts",
        storageKeys: [],
        registryPresent: true,
        registryAccountIds: (await this.listAccounts()).map((account) => account.id),
        registryHintsCount: 0,
        defaultEnvelopePresent: false,
        discoveredEnvelopeKeys: [],
        orphanEnvelopeKeys: [],
        selectedAccountId: this._sessionStore.snapshot().selectedAccountId || "",
        resolvedStatus: this._sessionStore.snapshot().status || "",
        reason: "",
      },
      toJSON() {
        return { diagnostic: this.diagnostic };
      },
    };
  }

  async listAccounts() {
    const accounts = coerceAccountList(await this._desktop.vault.listAccounts());
    let active = null;
    if (this._desktop.vault && typeof this._desktop.vault.getActiveIdentitySummary === "function") {
      try {
        active = await this._desktop.vault.getActiveIdentitySummary();
      } catch {
        active = null;
      }
    }
    return applyActiveAccountLabel(accounts, active);
  }

  selectAccount({ accountId } = {}) {
    const id = String(accountId == null ? "" : accountId).trim();
    if (!id) return false;
    this._sessionStore.setSelectedAccountId(id);
    return true;
  }

  async addAccount() {
    throw new Error("Desktop accounts are created through the desktop vault");
  }

  async setAccountIdHint() {
    return null;
  }

  async setDisplayName(accountId, displayName) {
    const id = String(accountId == null ? "" : accountId).trim();
    if (!id) return;
    const name = String(displayName == null ? "" : displayName).trim();
    if (!name) return;
    await this._desktop.vault.setProfileName({ accountId: id, profileName: name });
    this._sessionStore.setAccountList(await this.listAccounts());
  }

  async setAvatarFileHash(accountId, hash) {
    const id = String(accountId == null ? "" : accountId).trim();
    if (!id) return;
    await this._desktop.vault.setAvatarFileHash({
      accountId: id,
      avatarFileHash: typeof hash === "string" ? hash : "",
    });
  }

  async getAvatarFileHash(accountId) {
    const id = String(accountId == null ? "" : accountId).trim();
    if (!id) return "";
    const result = await this._desktop.vault.getAvatarFileHash({ accountId: id });
    return result && typeof result.avatarFileHash === "string" ? result.avatarFileHash : "";
  }

  async setAvatarDataB64(accountId, dataB64) {
    const id = String(accountId == null ? "" : accountId).trim();
    if (!id) return;
    await this._desktop.vault.setAvatarDataB64({
      accountId: id,
      avatarDataB64: typeof dataB64 === "string" ? dataB64 : "",
    });
  }

  async getAvatarDataB64(accountId) {
    const id = String(accountId == null ? "" : accountId).trim();
    if (!id) return "";
    const result = await this._desktop.vault.getAvatarDataB64({ accountId: id });
    return result && typeof result.avatarDataB64 === "string" ? result.avatarDataB64 : "";
  }

  async getLocalOnlyKeystoreSync() {
    return true;
  }

  async setLocalOnlyKeystoreSync() {}
}

export class DesktopAccountAuthService {
  constructor({ sessionStore, authBootstrapService, desktop = null } = {}) {
    if (!sessionStore || !authBootstrapService) {
      throw new Error("DesktopAccountAuthService requires sessionStore and authBootstrapService");
    }
    this._sessionStore = sessionStore;
    this._authBootstrapService = authBootstrapService;
    this._desktop = desktop || getDesktopBridge();
    this._account = null;
  }

  getAccount() {
    return this._account;
  }

  takePendingServerSyncEnvelope() {
    return null;
  }

  async createAccount({ profileName = "", password = "" } = {}) {
    const result = await this._desktop.vault.createAccount({ profileName, password });
    await this.#completeAuth(result);
    this._sessionStore.setAccountList(await this._authBootstrapService.listAccounts());
    return result;
  }

  async unlock({ accountId = null, password = "", enableDeviceUnlock = false } = {}) {
    const result = await this._desktop.vault.unlock({ accountId, password, enableDeviceUnlock: enableDeviceUnlock === true });
    await this.#completeAuth(result);
    this._sessionStore.setAccountList(await this._authBootstrapService.listAccounts());
    return result;
  }

  async unlockWithDevice({ accountId = null } = {}) {
    if (!this._desktop.vault || typeof this._desktop.vault.unlockWithDevice !== "function") {
      throw new Error("Device unlock unavailable: bridge does not expose vault.unlockWithDevice");
    }
    const result = await this._desktop.vault.unlockWithDevice({ accountId });
    await this.#completeAuth(result);
    this._sessionStore.setAccountList(await this._authBootstrapService.listAccounts());
    return result;
  }

  async disableDeviceUnlock({ accountId = null } = {}) {
    if (!this._desktop.vault || typeof this._desktop.vault.disableDeviceUnlock !== "function") {
      throw new Error("Device unlock unavailable: bridge does not expose vault.disableDeviceUnlock");
    }
    const result = await this._desktop.vault.disableDeviceUnlock({ accountId });
    this._sessionStore.setAccountList(await this._authBootstrapService.listAccounts());
    return result;
  }

  async revealMnemonic({ accountId = null, password = "" } = {}) {
    if (!this._desktop.vault || typeof this._desktop.vault.revealMnemonic !== "function") {
      throw new Error("Recovery phrase unavailable: bridge does not expose vault.revealMnemonic");
    }
    return this._desktop.vault.revealMnemonic({ accountId, password });
  }

  async resetPasswordWithMnemonic({ accountId = null, mnemonic = "", newPassword = "" } = {}) {
    if (!this._desktop.vault || typeof this._desktop.vault.resetPasswordWithMnemonic !== "function") {
      throw new Error("Recovery unavailable: bridge does not expose vault.resetPasswordWithMnemonic");
    }
    const result = await this._desktop.vault.resetPasswordWithMnemonic({ accountId, mnemonic, newPassword });
    // Vault auto-locks after reset; refresh account list so the UI can show
    // the cleared device-unlock state.
    this._sessionStore.setAccountList(await this._authBootstrapService.listAccounts());
    return result;
  }

  async exportBackup({ accountId = null, password = "" } = {}) {
    if (!this._desktop.vault || typeof this._desktop.vault.exportBackup !== "function") {
      throw new Error("Backup unavailable: bridge does not expose vault.exportBackup");
    }
    return this._desktop.vault.exportBackup({ accountId, password });
  }

  async importBackup({ encryptedBackup = null, mnemonic = "", newPassword = "" } = {}) {
    if (!this._desktop.vault || typeof this._desktop.vault.importBackup !== "function") {
      throw new Error("Restore unavailable: bridge does not expose vault.importBackup");
    }
    // Import creates + unlocks the restored account; complete auth the same way
    // createAccount/unlock do so the session lands UNLOCKED.
    const result = await this._desktop.vault.importBackup({ encryptedBackup, mnemonic, newPassword });
    await this.#completeAuth(result);
    this._sessionStore.setAccountList(await this._authBootstrapService.listAccounts());
    return result;
  }

  async changePassword({ accountId = null, oldPassword = "", newPassword = "" } = {}) {
    if (!this._desktop.vault || typeof this._desktop.vault.changePassword !== "function") {
      throw new Error("Change password unavailable: bridge does not expose vault.changePassword");
    }
    const result = await this._desktop.vault.changePassword({ accountId, oldPassword, newPassword });
    this._account = null;
    this._sessionStore.setAccountList(await this._authBootstrapService.listAccounts());
    this._sessionStore.setLocked({});
    return result;
  }

  async purgeAccount({ accountId = null, password = "" } = {}) {
    if (!this._desktop.vault || typeof this._desktop.vault.purgeAccount !== "function") {
      throw new Error("Delete account unavailable: bridge does not expose vault.purgeAccount");
    }
    const result = await this._desktop.vault.purgeAccount({ accountId, password });
    this._account = null;
    const list = await this._authBootstrapService.listAccounts();
    this._sessionStore.setAccountList(list);
    if (list.length === 0) {
      this._sessionStore.setNoKeystore();
    } else {
      this._sessionStore.setLocked({});
    }
    return result;
  }

  async logout() {
    this._account = null;
    await this._desktop.vault.lock();
    const list = await this._authBootstrapService.listAccounts();
    this._sessionStore.setAccountList(list);
    if (list.length === 0) {
      this._sessionStore.setNoKeystore();
      return;
    }
    this._sessionStore.setLocked({});
  }

  async #completeAuth(result) {
    const accountId = String(result && result.accountId ? result.accountId : "").trim();
    const deviceId = String(result && result.deviceId ? result.deviceId : "").trim();
    if (!accountId || !deviceId) throw new Error("Desktop vault did not return account/device identity");
    this._account = {
      accountId,
      deviceId,
      identityPublicKey: result && result.identityPublicKey ? result.identityPublicKey : null,
    };
    this._sessionStore.setUnlocked({
      accountId,
      deviceId,
    });
    this._sessionStore.setSelectedAccountId(accountId);
    if (this._sessionStore.snapshot().status !== SESSION_STATUS.UNLOCKED) {
      throw new Error("Desktop auth failed to unlock");
    }
  }
}
