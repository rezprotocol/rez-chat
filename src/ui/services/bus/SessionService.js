import { BaseBusService } from "./BaseBusService.js";
import { LoginDiagnosticResult } from "../../records/LoginDiagnosticResult.js";
import { AvatarGetResult } from "../../../records/results/AvatarGetResult.js";
import { nonEmptyString } from "../../../records/index.js";
import { SESSION_STATUS } from "../../stores/SessionStore.js";

export class SessionService extends BaseBusService {
  constructor({
    bus,
    authBootstrapService,
    accountAuthService,
    authStore,
    sessionStore,
    logger = console,
  } = {}) {
    super({ bus });
    if (!authBootstrapService || !accountAuthService || !authStore || !sessionStore) {
      throw new Error("SessionService requires authBootstrapService, accountAuthService, authStore, sessionStore");
    }
    this._authBootstrapService = authBootstrapService;
    this._accountAuthService = accountAuthService;
    this._authStore = authStore;
    this._sessionStore = sessionStore;
    this._logger = logger;
    this._runtimeConnectSeq = 0;
    this._register("session", "unlock", (payload) => this.unlock(payload));
    this._register("session", "unlockWithDevice", (payload) => this.unlockWithDevice(payload));
    this._register("session", "disableDeviceUnlock", (payload) => this.disableDeviceUnlock(payload));
    this._register("session", "create", (payload) => this.createAccount(payload));
    this._register("session", "lock", () => this.lock());
    this._register("session", "selectAccount", (payload) => this.selectAccount(payload));
    this._register("session", "inspectBootstrap", () => this.inspectBootstrap());
    this._register("session", "updateProfile", (payload) => this.updateProfile(payload));
    this._register("session", "getOwnAvatar", (payload) => this.getOwnAvatar(payload));
  }

  async init() {
    await this._authBootstrapService.init();
    this._syncFromAuth();
  }

  async inspectBootstrap() {
    const bootstrap = await this._authBootstrapService.inspectBootstrap();
    const snap = this._sessionStore.snapshot();
    const result = new LoginDiagnosticResult({
      diagnostic: bootstrap.diagnostic,
      session: {
        status: snap && snap.status ? String(snap.status) : "",
        error: snap && snap.error ? String(snap.error) : "",
        selectedAccountId: snap && snap.selectedAccountId ? String(snap.selectedAccountId) : "",
        accountListCount: Array.isArray(snap && snap.accountList) ? snap.accountList.length : 0,
        authScreen: this.bus.stores.uiState && typeof this.bus.stores.uiState.snapshot === "function"
          ? String(this.bus.stores.uiState.snapshot().authScreen || "unlock")
          : "unlock",
        showCreateBranch: this.bus.stores.uiState && typeof this.bus.stores.uiState.snapshot === "function"
          ? String(this.bus.stores.uiState.snapshot().authScreen || "unlock") === "create"
          : String(snap && snap.status || "") === SESSION_STATUS.NO_KEYSTORE,
      },
    });
    this.bus.emit("session.bootstrap.inspected", result);
    return result;
  }

  async unlock({ password = "", accountId = null, enableDeviceUnlock = false } = {}) {
    this._sessionStore.setUnlocking();
    try {
      const unlocked = await this._accountAuthService.unlock({
        accountId,
        password,
        enableDeviceUnlock: enableDeviceUnlock === true,
      });
      this._completeUnlock(unlocked);
      return this._sessionStore.snapshot();
    } catch (err) {
      const message = err && err.message ? err.message : "Unlock failed.";
      this._syncFromAuth();
      if (this._sessionStore.snapshot().status === SESSION_STATUS.UNLOCKING) {
        this._sessionStore.setLocked({ error: message });
      }
      this.bus.emit("session.unlock.failed", { message });
      throw err;
    }
  }

  async unlockWithDevice({ accountId = null } = {}) {
    this._sessionStore.setUnlocking();
    try {
      const unlocked = await this._accountAuthService.unlockWithDevice({ accountId });
      this._completeUnlock(unlocked);
      return this._sessionStore.snapshot();
    } catch (err) {
      const message = err && err.message ? err.message : "Device unlock failed.";
      this._syncFromAuth();
      if (this._sessionStore.snapshot().status === SESSION_STATUS.UNLOCKING) {
        this._sessionStore.setLocked({ error: "" });
      }
      this.bus.emit("session.unlock.failed", { message });
      throw err;
    }
  }

  async disableDeviceUnlock({ accountId = null } = {}) {
    const snap = this._sessionStore.snapshot();
    const resolved = accountId || (snap && snap.selectedAccountId) || (snap && snap.accountId) || null;
    const result = await this._accountAuthService.disableDeviceUnlock({ accountId: resolved });
    this._syncFromAuth({ keepStatus: true });
    this.bus.emit("session.deviceUnlock.disabled", { accountId: resolved });
    return result;
  }

  _completeUnlock(unlocked) {
    this._syncFromAuth({ keepStatus: true });
    this._sessionStore.setUnlocked({
      accountId: unlocked && unlocked.accountId ? unlocked.accountId : null,
      deviceId: unlocked && unlocked.deviceId ? unlocked.deviceId : null,
      localInboxId: unlocked && unlocked.localInboxId ? unlocked.localInboxId : null,
      ownerAccountId: unlocked && unlocked.ownerAccountId ? unlocked.ownerAccountId : null,
    });
    this.bus.emit("session.unlocked", this._sessionStore.snapshot());
    const connectSeq = ++this._runtimeConnectSeq;
    this._connectRuntimeAfterUnlock({ connectSeq }).catch((err) => {
      if (this._logger && typeof this._logger.warn === "function") {
        this._logger.warn("runtime connect failed after unlock", err && err.message ? err.message : err);
      }
    });
  }

  async createAccount({ name = "", profileName = "", password = "", confirmPassword = "" } = {}) {
    const resolvedName = nonEmptyString(name) || nonEmptyString(profileName);
    if (String(password) !== String(confirmPassword)) {
      this._sessionStore.setError("Passwords do not match.");
      return null;
    }
    this._sessionStore.setUnlocking();
    try {
      const unlocked = await this._accountAuthService.createAccount({
        profileName: resolvedName,
        password,
      });
      this._syncFromAuth({ keepStatus: true });
      this._sessionStore.setUnlocked({
        accountId: unlocked && unlocked.accountId ? unlocked.accountId : null,
        deviceId: unlocked && unlocked.deviceId ? unlocked.deviceId : null,
        localInboxId: unlocked && unlocked.localInboxId ? unlocked.localInboxId : null,
        ownerAccountId: unlocked && unlocked.ownerAccountId ? unlocked.ownerAccountId : null,
      });
      this.bus.emit("session.unlocked", this._sessionStore.snapshot());
      const connectSeq = ++this._runtimeConnectSeq;
      this._connectRuntimeAfterUnlock({ connectSeq }).catch((err) => {
        if (this._logger && typeof this._logger.warn === "function") {
          this._logger.warn("runtime connect failed after account creation", err && err.message ? err.message : err);
        }
      });
      return this._sessionStore.snapshot();
    } catch (err) {
      const message = err && err.message ? err.message : "Account creation failed.";
      this._syncFromAuth();
      this._sessionStore.setError(message);
      throw err;
    }
  }

  async updateProfile({ displayName, avatarDataB64 } = {}) {
    const name = typeof displayName === "string" ? displayName.trim() : "";
    if (!name) {
      throw new Error("updateProfile requires non-empty displayName");
    }

    const accountId = this._resolveAccountId();
    if (!accountId) {
      throw new Error("updateProfile: no active account");
    }

    await this._authBootstrapService.setDisplayName(accountId, name);
    this._syncFromAuth({ keepStatus: true });
    this.bus.emit("session.updated", this._sessionStore.snapshot());

    const client = this.bus.runtime && this.bus.runtime.client ? this.bus.runtime.client : null;
    if (client && typeof client.call === "function") {
      const broadcastPayload = { displayName: name };
      if (typeof avatarDataB64 === "string") {
        broadcastPayload.avatarDataB64 = avatarDataB64;
      }
      const result = await client.call("profile.broadcast", broadcastPayload).catch((err) => {
        if (this._logger && typeof this._logger.warn === "function") {
          this._logger.warn("profile broadcast failed after updateProfile", err && err.message ? err.message : err);
        }
        return null;
      });
      if (result && typeof result.avatarFileHash === "string" && result.avatarFileHash.length > 0) {
        await this._authBootstrapService.setAvatarFileHash(accountId, result.avatarFileHash).catch((err) => {
          if (this._logger && typeof this._logger.warn === "function") {
            this._logger.warn("failed to persist avatar hash", err && err.message ? err.message : err);
          }
        });
      }
      if (typeof avatarDataB64 === "string") {
        await this._authBootstrapService.setAvatarDataB64(accountId, avatarDataB64).catch((err) => {
          if (this._logger && typeof this._logger.warn === "function") {
            this._logger.warn("failed to persist avatar data locally", err && err.message ? err.message : err);
          }
        });
        this.bus.emit("session.avatarChanged", { accountId });
      }
    }

    return this._sessionStore.snapshot();
  }

  async getOwnAvatar({ accountId: explicitId } = {}) {
    const accountId = typeof explicitId === "string" && explicitId.trim()
      ? explicitId.trim()
      : this._resolveAccountId();
    if (!accountId) return new AvatarGetResult({ avatarDataB64: "" });
    const avatarDataB64 = await this._authBootstrapService.getAvatarDataB64(accountId);
    return new AvatarGetResult({ avatarDataB64 });
  }

  async _syncAvatarFromServer() {
    const client = this.bus.runtime && this.bus.runtime.client ? this.bus.runtime.client : null;
    if (!client || typeof client.call !== "function") return;

    const accountId = this._resolveAccountId();
    if (!accountId) return;

    const profile = await client.call("profile.getOwn", {});
    const serverHash = typeof profile.avatarFileHash === "string" ? profile.avatarFileHash : "";
    const localHash = await this._authBootstrapService.getAvatarFileHash(accountId);

    if (serverHash === localHash) return;

    // Server reports no avatar but device has one persisted. Local is the
    // source of truth for this device — explicit removal goes through
    // updateProfile({ avatarDataB64: "" }), which clears local directly.
    // Sync must never wipe local based on the server's in-memory view; the
    // server's #ownerAvatarFileHash is null on any cold start before profile
    // meta finishes loading, and a wipe here destroys the user's avatar.
    if (!serverHash) return;

    const fileResult = await client.call("file.get", { fileHashHex: serverHash }).catch((err) => {
      if (this._logger && typeof this._logger.warn === "function") {
        this._logger.warn("avatar file fetch failed during sync", err && err.message ? err.message : err);
      }
      return null;
    });
    if (!fileResult || typeof fileResult.fileDataB64 !== "string" || fileResult.fileDataB64.length === 0) {
      // Don't update local hash without bytes — that would leave hash and
      // data inconsistent and the next sync would falsely report "match".
      return;
    }
    await this._authBootstrapService.setAvatarFileHash(accountId, serverHash);
    await this._authBootstrapService.setAvatarDataB64(accountId, fileResult.fileDataB64);
    this.bus.emit("session.avatarChanged", { accountId });
  }

  selectAccount({ accountId } = {}) {
    this._authBootstrapService.selectAccount({ accountId });
    this._syncFromAuth({ keepStatus: true });
  }

  async lock() {
    this._runtimeConnectSeq += 1;
    try {
      await this.bus.call("runtime", "disconnect", {});
    } catch (err) {
      if (this._logger && typeof this._logger.warn === "function") {
        this._logger.warn("runtime disconnect failed during lock", err && err.message ? err.message : err);
      }
    }
    await this._accountAuthService.logout();
    this._syncFromAuth();
    this.bus.emit("session.locked", this._sessionStore.snapshot());
  }

  async _connectRuntimeAfterUnlock({ connectSeq } = {}) {
    const connected = await this.bus.call("runtime", "connect", {});
    if (connectSeq !== this._runtimeConnectSeq) {
      return null;
    }
    const snap = this._sessionStore.snapshot();
    if (snap.status !== SESSION_STATUS.UNLOCKED) {
      return null;
    }
    this._sessionStore.setUnlocked({
      accountId: connected && connected.accountId ? connected.accountId : snap.accountId,
      deviceId: connected && connected.deviceId ? connected.deviceId : snap.deviceId,
      localInboxId: connected && connected.sessionHandles ? connected.sessionHandles.localInboxId : snap.localInboxId,
      ownerAccountId: connected && connected.sessionHandles ? connected.sessionHandles.ownerAccountId : snap.ownerAccountId,
    });
    this.bus.emit("session.runtime.connected", this._sessionStore.snapshot());
    this._syncAvatarFromServer().catch((err) => {
      if (this._logger && typeof this._logger.warn === "function") {
        this._logger.warn("avatar sync after connect failed", err && err.message ? err.message : err);
      }
    });
    return connected;
  }

  _resolveAccountId() {
    const snap = this._sessionStore.snapshot();
    if (snap && snap.selectedAccountId) return String(snap.selectedAccountId).trim();
    if (snap && snap.accountId) return String(snap.accountId).trim();
    return "";
  }

  _syncFromAuth({ keepStatus = false } = {}) {
    const snap = this._authStore.snapshot();
    const list = Array.isArray(snap.accountList) ? snap.accountList : [];
    this._sessionStore.setAccountList(list);
    this._sessionStore.setSelectedAccountId(snap.selectedAccountId);
    this._sessionStore.setCanAddAccount(true);
    if (keepStatus) {
      if (snap.error) this._sessionStore.setError(snap.error);
      return;
    }
    if (snap.status === "NO_KEYSTORE") {
      this._sessionStore.setNoKeystore();
      return;
    }
    if (snap.status === "LOCKED") {
      this._sessionStore.setLocked({ error: snap.error });
      return;
    }
    if (snap.status === "UNLOCKED") {
      this._sessionStore.setUnlocked({
        accountId: snap.accountId,
        deviceId: snap.deviceId,
      });
      return;
    }
    if (snap.status === "LOCKING") {
      this._sessionStore.setLocking();
      return;
    }
    this._sessionStore.setUnlocking();
  }
}
