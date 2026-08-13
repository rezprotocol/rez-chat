import path from "node:path";
import { DesktopBusBridge } from "./DesktopBusBridge.js";
import { runDeviceLinkRequester } from "./DesktopDeviceLinkRunner.js";

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
  #deviceLinkRunner;
  #rezChatOptions;
  #chatApp;
  #userEnvironment;
  #busBridge;
  #logger;
  #started;
  #chatAppListeners;

  /** True when a lock left the runtime live and every escalation failed. Surfaced by status(). */
  #lockIncomplete;

  constructor({
    vault,
    startRezChat = null,
    rezChatOptions = {},
    chatApp = null,
    userEnvironment = null,
    deviceLinkRunner = null,
    logger = console,
  } = {}) {
    if (!vault) throw new Error("DesktopSupervisor requires vault");
    this.#vault = vault;
    this.#startRezChat = typeof startRezChat === "function" ? startRezChat : null;
    this.#deviceLinkRunner = typeof deviceLinkRunner === "function" ? deviceLinkRunner : runDeviceLinkRequester;
    this.#rezChatOptions = rezChatOptions && typeof rezChatOptions === "object" ? rezChatOptions : {};
    this.#chatApp = chatApp || null;
    this.#userEnvironment = userEnvironment || null;
    this.#busBridge = null;
    this.#logger = logger || console;
    this.#started = false;
    this.#chatAppListeners = new Set();
    this.#lockIncomplete = false;
    // AUDIT #4 — auto-lock must fail closed over the chat runtime. Registered HERE, unconditionally,
    // so it is intrinsic to having a supervisor rather than optional wiring a caller can forget: the
    // previous `onAutoLock` constructor option had no caller anywhere, so every idle/absolute
    // timeout locked the vault and left the runtime live.
    if (typeof this.#vault.setAutoLockHandler !== "function") {
      throw new Error(
        "DesktopSupervisor requires a vault exposing setAutoLockHandler(): without it an idle or"
          + " absolute timeout locks the vault and leaves the chat runtime live, which is the exact"
          + " failure this wiring exists to prevent",
      );
    }
    this.#vault.setAutoLockHandler((reason) => this.#onVaultAutoLocked(reason));
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
      // Sticky: a lock that could not stop the runtime is an unsafe state an operator must see,
      // not a transient the next status() call washes away. Cleared only by a lock that succeeds.
      lockIncomplete: this.#lockIncomplete === true,
      vault: vaultStatus,
    };
  }

  vaultStatus() {
    return this.#vault.status();
  }

  /**
   * Machine capabilities probed at boot (os/arch, keychain, biometric). The
   * UI reads this to adapt its surface — e.g. hide the "remember on this
   * device" option when no keychain is available.
   *
   * With a UserEnvironment (Tauri sidecar) the full probe is returned. Without
   * one (Electron / legacy / tests), keychain availability is derived from the
   * vault's safeStorage so the device-unlock gate stays correct on that shell.
   */
  environmentCapabilities() {
    if (this.#userEnvironment && typeof this.#userEnvironment.capabilities === "function") {
      return this.#userEnvironment.capabilities();
    }
    const vaultStatus = this.#vault.status();
    return {
      os: process.platform,
      arch: process.arch,
      keychainAvailable: !!(vaultStatus && vaultStatus.osWrapAvailable === true),
      biometricAvailable: false,
      notificationsAllowed: null,
    };
  }

  async createAccount(params = {}) {
    return this.#vault.createAccount(params);
  }

  /**
   * S10 — link THIS device to an existing account (the NEW-device half of the
   * PSK ceremony). Runs the requester over a temporary SDK client against the
   * LOCAL node (which is up pre-login), then provisions the delegated vault
   * row. Does NOT connect: the UI drives the normal unlock→connect path so
   * the delegated chat server boots through the shipped S9 flow.
   */
  async linkDevice({ linkCode = "", profileName = "", password = "" } = {}) {
    const code = normalizeString(linkCode);
    if (!code) throw new Error("linkDevice requires linkCode");
    if (this.#chatApp && this.#chatApp.chatServer != null) {
      throw new Error("linkDevice: a chat session is active — log out before linking this device");
    }
    if (!this.#chatApp && this.#startRezChat) {
      this.#chatApp = await this.#startRezChat(this.#rezChatOptions);
      this.#notifyChatAppListeners();
    }
    const wsUrl = this.#chatApp && typeof this.#chatApp.wsUrl === "string" ? this.#chatApp.wsUrl : "";
    if (!wsUrl) {
      throw new Error("linkDevice: local node unavailable (chat shell not started)");
    }
    let expectedNodePublicKeyB64 = "";
    if (this.#chatApp.nodeApp && this.#chatApp.nodeApp.runtime
      && typeof this.#chatApp.nodeApp.runtime.getIdentity === "function") {
      const nodeIdentity = this.#chatApp.nodeApp.runtime.getIdentity();
      expectedNodePublicKeyB64 = nodeIdentity && typeof nodeIdentity.nodePublicKeyB64 === "string"
        ? nodeIdentity.nodePublicKeyB64
        : "";
    }
    const result = await this.#deviceLinkRunner({
      linkCode: code,
      wsUrl,
      expectedNodePublicKeyB64,
      logger: this.#logger,
      persistDelegation: (linked) => this.#vault.createDelegatedAccount({
        profileName,
        password,
        deviceKeyPair: linked.delegation.deviceKeyPair,
        delegationBundle: {
          accountSignPublicKeyB64: linked.delegation.accountSignPublicKeyB64,
          accountDhKeyPair: linked.delegation.accountDhKeyPair,
          certChain: linked.delegation.certChain,
          cachedDeviceSet: linked.delegation.cachedDeviceSet,
        },
        inboxId: linked.inboxId,
      }),
    });
    return result.persistence;
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

  /**
   * Lock the vault AND tear down the chat runtime (audit #4).
   *
   * Locking used to mean `vault.lock()` and nothing else — which zeroes the vault's own copy of the
   * keys while the chat-server keeps running: still connected to the node, still holding its own
   * identity, still sending and receiving. "Locked" was a UI state, not a security boundary.
   *
   * ORDER AND GUARANTEE. The runtime is torn down FIRST (stop new work), but the vault lock runs in
   * a `finally` so it happens even if teardown throws — zeroization is the one thing we can always
   * do, and skipping it because something else failed would be strictly worse. A teardown failure
   * is then reported, not swallowed: the returned status carries `runtimeStopped: false` and the
   * failure is logged as the security event it is.
   *
   * @returns {Promise<object>} the vault status, plus `runtimeStopped`
   */
  async lock() {
    let teardownError = null;
    try {
      await this.disconnect();
    } catch (err) {
      teardownError = err;
    } finally {
      this.#vault.lock();
    }
    // THROWS on an incomplete lock. A locked vault beside a verified-live runtime is the original
    // security failure, merely reported accurately — so the caller must not be able to read it as
    // success. The IPC layer turns this into { ok: false, error: { code: "LOCK_INCOMPLETE" } } and
    // the UI's unwrap() rethrows it, so no path presents it as a lock.
    return this.#finishLock(teardownError, "lock", true);
  }

  /**
   * The vault's idle/absolute timer already locked it; bring the runtime down to match.
   *
   * NOBODY IS AWAITING THIS. There is no user to see a thrown error and no caller to retry, so
   * escalation has to be self-contained: a failed graceful teardown is followed by a TERMINAL
   * shutdown of the whole chat app, and if even that fails the supervisor records an unsafe state
   * that `status()` reports rather than leaving the fact in a log line nobody reads.
   */
  async #onVaultAutoLocked(reason) {
    let teardownError = null;
    try {
      await this.disconnect();
    } catch (err) {
      teardownError = err;
    }
    await this.#finishLock(teardownError, "auto-lock (" + reason + ")", false);
  }

  /** Is the chat runtime actually down? The same signal status() reports — checked, not assumed. */
  #runtimeIsDown() {
    return this.#chatApp == null || this.#chatApp.chatServer == null;
  }

  /**
   * Verify the post-condition, ESCALATE if it failed, and only then decide the outcome.
   *
   * chatApp.stopChatServer() logs and swallows a failing chatServer.stop(), so a broken teardown
   * returns normally — trusting it would report a clean lock over a live session. When the graceful
   * path leaves the runtime up, the escalation is a full `chatApp.stop()`: it costs the next unlock
   * a cold boot, which is the right trade against leaving an unlocked session running.
   *
   * @param {Error|null} teardownError
   * @param {string} label
   * @param {boolean} throwOnFailure — true for the explicit path (a caller is waiting)
   */
  async #finishLock(teardownError, label, throwOnFailure) {
    if (this.#runtimeIsDown()) {
      this.#lockIncomplete = false;
      return { ...this.#vault.status(), runtimeStopped: true, escalated: false };
    }
    const detail = teardownError && teardownError.message ? teardownError.message : "chat-server is still attached";
    if (this.#logger && typeof this.#logger.error === "function") {
      this.#logger.error("[desktop] " + label + ": graceful teardown left the chat runtime LIVE ("
        + detail + ") — forcing a terminal shutdown");
    }
    const forced = await this.#forceRuntimeShutdown(label);
    if (forced && this.#runtimeIsDown()) {
      this.#lockIncomplete = false;
      return { ...this.#vault.status(), runtimeStopped: true, escalated: true };
    }
    // Nothing left to try. Record it so it is observable in status(), not only in a log.
    this.#lockIncomplete = true;
    if (this.#logger && typeof this.#logger.error === "function") {
      this.#logger.error("[desktop] " + label + ": LOCK INCOMPLETE — the vault is locked but the chat"
        + " runtime could not be stopped and may still be live. Manual intervention required.");
    }
    if (throwOnFailure) {
      const err = new Error("the vault is locked but the chat runtime could not be stopped");
      err.code = "LOCK_INCOMPLETE";
      throw err;
    }
    return { ...this.#vault.status(), runtimeStopped: false, escalated: true };
  }

  /** Terminal teardown: stop the whole chat app (node + shell), not just the chat-server. */
  async #forceRuntimeShutdown(label) {
    const app = this.#chatApp;
    if (!app) return true;
    try {
      if (typeof app.stop === "function") await app.stop();
      // Cleared so supervisor.stop() does not double-stop, matching the legacy disconnect path.
      this.#chatApp = null;
      this.#notifyChatAppListeners();
      return true;
    } catch (err) {
      if (this.#logger && typeof this.#logger.error === "function") {
        this.#logger.error("[desktop] " + label + ": terminal chat-app shutdown FAILED: "
          + (err && err.message ? err.message : err));
      }
      return false;
    }
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
    let chatServerStarted = false;
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
      const deviceKey = typeof this.#vault.getActiveDeviceKey === "function"
        ? this.#vault.getActiveDeviceKey()
        : null;
      await this.#chatApp.startChatServer({
        chatServerIdentity,
        deviceKey,
        allowChatServerIdentityRotation: true,
      });
      chatServerStarted = true;
    }
    if (!this.#busBridge) {
      this.#busBridge = new DesktopBusBridge({ chatApp: this.#chatApp });
    }
    // Notify when the chatApp is new OR the chat-server was (re)started on an
    // existing chatApp (logout→login): consumers like the tray badge bind to
    // chatApp.chatServer, so a fresh server instance needs a rebind.
    if (chatAppChanged || chatServerStarted) this.#notifyChatAppListeners();
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
