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
    this.#vault.close();
    this.#started = false;
  }

  status() {
    const vaultStatus = this.#vault.status();
    return {
      started: this.#started === true,
      runtimeConnected: this.#chatApp != null,
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
    const app = this.#chatApp;
    const hadChatApp = app != null;
    this.#chatApp = null;
    if (app && typeof app.stop === "function") {
      await app.stop();
    }
    if (hadChatApp) this.#notifyChatAppListeners();
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
      connected: this.#chatApp != null,
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
