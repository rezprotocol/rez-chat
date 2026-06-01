import path from "node:path";
import { DesktopBusBridge } from "./DesktopBusBridge.mjs";

function normalizeString(value) {
  return String(value == null ? "" : value).trim();
}

/**
 * Owns desktop process lifecycle: vault open/close, chat-server start/stop,
 * and the IPC bus bridge.
 *
 * Public surface is intentionally narrow: vault ops, lifecycle, and one
 * accessor for the bus bridge (`getBusBridge()`). Every chat directive flows
 * through the bridge generically — there are NO per-directive methods on
 * this class. See `rez-chat/test/architecture.no-ipc-facade.test.js` for the
 * allowlist enforcement.
 */
export class DesktopSupervisor {
  #vault;
  #startRezChat;
  #rezChatOptions;
  #chatApp;
  #busBridge;
  #logger;
  #started;
  #chatAppListeners;

  constructor({
    vault,
    startRezChat = null,
    rezChatOptions = {},
    chatApp = null,
    logger = console,
  } = {}) {
    if (!vault) throw new Error("DesktopSupervisor requires vault");
    this.#vault = vault;
    this.#startRezChat = typeof startRezChat === "function" ? startRezChat : null;
    this.#rezChatOptions = rezChatOptions && typeof rezChatOptions === "object" ? rezChatOptions : {};
    this.#chatApp = chatApp || null;
    this.#busBridge = null;
    this.#logger = logger || console;
    this.#started = false;
    this.#chatAppListeners = new Set();
  }

  /**
   * Subscribe to chatApp lifecycle transitions. Fires synchronously with the
   * current chatApp (or null) when registered, and again on every connect/
   * disconnect. Returns an unsubscribe function. Used by the tray badge so it
   * can re-bind to a fresh chat-server bus across logout/login.
   */
  onChatAppChange(handler) {
    if (typeof handler !== "function") return () => {};
    this.#chatAppListeners.add(handler);
    try {
      handler(this.#chatApp);
    } catch (err) {
      if (this.#logger && typeof this.#logger.warn === "function") {
        this.#logger.warn("[desktop] onChatAppChange initial fire failed", err && err.message ? err.message : err);
      }
    }
    return () => { this.#chatAppListeners.delete(handler); };
  }

  #notifyChatAppListeners() {
    for (const handler of [...this.#chatAppListeners]) {
      try {
        handler(this.#chatApp);
      } catch (err) {
        if (this.#logger && typeof this.#logger.warn === "function") {
          this.#logger.warn("[desktop] chatApp listener failed", err && err.message ? err.message : err);
        }
      }
    }
  }

  async start() {
    if (this.#started) return this.status();
    this.#vault.open();
    this.#started = true;
    return this.status();
  }

  async stop() {
    await this.disconnect().catch((err) => {
      if (this.#logger && typeof this.#logger.warn === "function") {
        this.#logger.warn("[desktop] runtime disconnect during stop failed", err && err.message ? err.message : err);
      }
    });
    // Full chat-app teardown: node + shell. disconnect() already stopped
    // chat-server (if started) but kept node+shell up for re-login; stop()
    // means we're done for good.
    if (this.#chatApp && typeof this.#chatApp.stop === "function") {
      try {
        await this.#chatApp.stop();
      } catch (err) {
        if (this.#logger && typeof this.#logger.warn === "function") {
          this.#logger.warn("[desktop] chatApp.stop failed", err && err.message ? err.message : err);
        }
      }
    }
    this.#chatApp = null;
    this.#vault.close();
    this.#started = false;
  }

  status() {
    const vaultStatus = this.#vault.status();
    // "connected" tracks whether chat-server is actually running, not whether
    // the chatApp shell is alive. After the deferred-bootstrap refactor the
    // chatApp survives disconnect (node + shell stay up for re-login); the
    // chat-server is what comes and goes per unlock.
    return {
      started: this.#started === true,
      runtimeConnected: this.#chatApp != null && this.#chatApp.chatServer != null,
      vault: vaultStatus,
    };
  }

  vaultStatus() {
    return this.#vault.status();
  }

  async createAccount(params = {}) {
    return this.#vault.createAccount(params);
  }

  async unlock(params = {}) {
    return this.#vault.unlock(params);
  }

  async unlockWithDevice(params = {}) {
    return this.#vault.unlockWithDevice(params);
  }

  disableDeviceUnlock(params = {}) {
    return this.#vault.disableDeviceUnlock(params);
  }

  lock() {
    return this.#vault.lock();
  }

  /**
   * Forward renderer-visible activity to the vault's auto-relock timer.
   * SECURITY_AUDIT MED-17. Called from the bus:call IPC handler on every
   * renderer-initiated directive; no-op when the vault is locked.
   */
  noteVaultActivity() {
    if (typeof this.#vault.noteActivity === "function") {
      this.#vault.noteActivity();
    }
  }

  listAccounts() {
    return { accounts: this.#vault.listAccounts() };
  }

  getActiveIdentitySummary() {
    return this.#vault.getActiveIdentitySummary();
  }

  setProfileName(params = {}) {
    return this.#vault.setProfileName(params);
  }

  setAvatarFileHash(params = {}) {
    return this.#vault.setAvatarFileHash(params);
  }

  getAvatarFileHash(params = {}) {
    return this.#vault.getAvatarFileHash(params);
  }

  setAvatarDataB64(params = {}) {
    return this.#vault.setAvatarDataB64(params);
  }

  getAvatarDataB64(params = {}) {
    return this.#vault.getAvatarDataB64(params);
  }

  // ---- BIP39 recovery + change-password + purge --------------------------

  revealMnemonic(params = {}) {
    return this.#vault.revealMnemonic(params);
  }

  async resetPasswordWithMnemonic(params = {}) {
    // Auto-disconnects any live chat-server session since the password reset
    // also clears device-unlock and re-wraps every envelope; subsequent unlock
    // is mandatory.
    if (this.#chatApp) {
      await this.disconnect();
    }
    return this.#vault.resetPasswordWithMnemonic(params);
  }

  async changePassword(params = {}) {
    // Same disconnect-first pattern: the vault auto-locks after a successful
    // change so the user has to unlock with the new password.
    if (this.#chatApp) {
      await this.disconnect();
    }
    return this.#vault.changePassword(params);
  }

  exportBackup(params = {}) {
    // Pure read: produces the encrypted envelope from the active/specified
    // account. No runtime teardown — the session stays as-is.
    return this.#vault.exportBackup(params);
  }

  async importBackup(params = {}) {
    // Import creates + unlocks a NEW active account; disconnect any live
    // session first (mirrors resetPasswordWithMnemonic/changePassword).
    if (this.#chatApp) {
      await this.disconnect();
    }
    return this.#vault.importBackup(params);
  }

  async purgeAccount(params = {}) {
    if (this.#chatApp) {
      await this.disconnect();
    }
    // Wipe the chat-server data dir (identity blob, ratchets, messages,
    // peer-link state) BEFORE deleting the vault row. Otherwise the next
    // account-create on this device hits a stored chat-server identity
    // mismatch from the purged account. removeChatServerData is optional on
    // the chatApp so tests with a minimal fake don't have to implement it.
    if (this.#chatApp && typeof this.#chatApp.removeChatServerData === "function") {
      try {
        this.#chatApp.removeChatServerData();
      } catch (err) {
        if (this.#logger && typeof this.#logger.warn === "function") {
          this.#logger.warn("[desktop] removeChatServerData failed", err && err.message ? err.message : err);
        }
      }
    }
    return this.#vault.purgeAccount(params);
  }

  async connect() {
    this.#requireUnlocked();
    let chatAppChanged = false;
    if (!this.#chatApp) {
      if (!this.#startRezChat) {
        return this.#runtimeSummary();
      }
      this.#chatApp = await this.#startRezChat(this.#rezChatOptions);
      chatAppChanged = true;
    }
    // Lazy chat-server bootstrap rooted in the vault's BIP39-derived identity.
    // Optional on the chatApp so test fakes (which pre-populate chatServer)
    // continue to work. When supported AND chat-server isn't already running,
    // require an identity from the vault — otherwise we'd silently fall back
    // to a random identity that doesn't match the user's mnemonic.
    if (typeof this.#chatApp.startChatServer === "function" && this.#chatApp.chatServer == null) {
      const chatServerIdentity = typeof this.#vault.getChatServerIdentity === "function"
        ? this.#vault.getChatServerIdentity()
        : null;
      if (!chatServerIdentity) {
        throw new Error(
          "DesktopSupervisor.connect: vault has no chat-server identity. "
          + "Pre-BIP39 accounts must be re-created (Phase 6 migration).",
        );
      }
      // allowChatServerIdentityRotation=true so that pre-existing chat-server
      // data dirs (carried over from before this refactor) get rotated to the
      // mnemonic-derived identity instead of throwing on mismatch. Once
      // Phase 6's pre-BIP39 wipe lands at launch time, this can tighten to
      // false in steady-state.
      await this.#chatApp.startChatServer({
        chatServerIdentity,
        allowChatServerIdentityRotation: true,
      });
    }
    if (!this.#busBridge) {
      this.#busBridge = new DesktopBusBridge({ chatApp: this.#chatApp });
    }
    if (chatAppChanged) this.#notifyChatAppListeners();
    return this.#runtimeSummary();
  }

  async disconnect() {
    if (this.#busBridge) {
      this.#busBridge.close();
      this.#busBridge = null;
    }
    if (!this.#chatApp) {
      return this.#runtimeSummary();
    }
    // New lifecycle: stopChatServer keeps node+shell up so the next unlock
    // doesn't pay full boot cost. Legacy/test path falls back to full stop()
    // which means chatApp won't survive the disconnect — we null it out so
    // supervisor.stop() doesn't double-stop.
    if (typeof this.#chatApp.stopChatServer === "function") {
      await this.#chatApp.stopChatServer();
    } else {
      const app = this.#chatApp;
      this.#chatApp = null;
      if (typeof app.stop === "function") {
        await app.stop();
      }
    }
    this.#notifyChatAppListeners();
    return this.#runtimeSummary();
  }

  /**
   * The IPC layer (`registerDesktopRuntimeIpc`) calls this to attach
   * `bus:call` and `bus:event` handlers. UI tests use it to drive the
   * dispatcher without spinning up Electron.
   */
  getBusBridge() {
    if (!this.#busBridge) {
      throw new Error("DesktopSupervisor.getBusBridge: not connected");
    }
    return this.#busBridge;
  }

  #runtimeSummary() {
    const active = this.#vault.getActiveIdentitySummary();
    const chatSession = this.#chatSessionInfo();
    const localInboxId = normalizeString(chatSession && chatSession.localInboxId);
    // The chat-server stamps every outbound message with its own identity
    // (see ChatServerIdentity / BaseServerService.ownerAccountId), which is
    // distinct from the vault accountId. The UI's isSelfIdentity check has
    // to see the chat-server identity in the session snapshot or own
    // messages render as someone else's. Prefer the chat-server's
    // accountId for ownerAccountId; fall back to vault on early/test paths
    // that don't surface a session service.
    const chatOwnerAccountId = normalizeString(chatSession && chatSession.accountId);
    const ownerAccountId = chatOwnerAccountId
      || (active && active.accountId ? active.accountId : null);
    return {
      connected: this.#chatApp != null && this.#chatApp.chatServer != null,
      accountId: active && active.accountId ? active.accountId : null,
      deviceId: active && active.deviceId ? active.deviceId : null,
      localInboxId: localInboxId || null,
      ownerAccountId: ownerAccountId || null,
    };
  }

  #chatSessionInfo() {
    const app = this.#chatApp;
    const server = app && app.chatServer ? app.chatServer : null;
    const bus = server && server.bus ? server.bus : null;
    const services = bus && bus.services ? bus.services : null;
    const session = services && services.session ? services.session : null;
    if (session && typeof session.getSessionInfo === "function") {
      const info = session.getSessionInfo();
      if (info && typeof info === "object") return info;
    }
    const runtime = services && services.runtime ? services.runtime : null;
    const nodeRuntime = runtime && runtime.nodeRuntime ? runtime.nodeRuntime : null;
    if (nodeRuntime && typeof nodeRuntime.getIdentity === "function") {
      const identity = nodeRuntime.getIdentity();
      if (identity && typeof identity === "object") {
        return {
          localInboxId: normalizeString(identity.localInboxId),
        };
      }
    }
    return {};
  }

  #requireUnlocked() {
    const active = this.#vault.getActiveIdentitySummary();
    if (!active || !active.accountId) throw new Error("Desktop runtime requires unlocked vault");
    return active;
  }
}

export function defaultDesktopPaths(userDataDir) {
  const root = normalizeString(userDataDir);
  if (!root) throw new Error("defaultDesktopPaths requires userDataDir");
  return {
    vaultDbPath: path.join(root, "desktop-vault.sqlite"),
    nodeConfigPath: path.join(root, "rez.config.json"),
  };
}
