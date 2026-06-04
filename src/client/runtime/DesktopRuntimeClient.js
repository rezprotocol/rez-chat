function getDesktopBridge() {
  const root = typeof globalThis !== "undefined" ? globalThis : {};
  const windowRef = root && root.window ? root.window : null;
  const bridge = root.rezDesktop || (windowRef && windowRef.rezDesktop) || null;
  return bridge && typeof bridge === "object" ? bridge : null;
}

function coerceRezPayload(payload) {
  if (payload === null || payload === undefined) return {};
  if (Array.isArray(payload)) return payload;
  if (typeof payload === "object") return payload;
  return { value: payload };
}

/**
 * Desktop SDK client.
 *
 * Generic over the bus protocol: `call(method, params)` dispatches via the
 * preload's `rezDesktop.bus.call`; `onEvent(name, handler)` subscribes via
 * `rezDesktop.bus.on`. No per-directive methods — adding a new bus directive
 * requires zero changes here.
 *
 * UI services consume this through `bus.runtime.client` and call
 * `client.call("namespace.name", params)`. Methods that are NOT pure dispatch
 * (sendRezPayload payload normalization, vault/runtime lifecycle, the backup
 * stub) keep their named forms because they add real shape adaptation.
 */
export class DesktopRuntimeClient {
  constructor({ desktop = null } = {}) {
    this._desktop = desktop || getDesktopBridge();
    if (!this._desktop || !this._desktop.runtime || !this._desktop.bus || typeof this._desktop.bus.call !== "function") {
      throw new Error("DesktopRuntimeClient requires rezDesktop.bus.call (generic bus IPC)");
    }
    this._sessionInfo = null;
    this._stateHandlers = [];
    this._offConnection = typeof this._desktop.bus.on === "function"
      ? this._desktop.bus.on("connection.state", (payload) => {
          const row = payload && typeof payload === "object" ? payload : {};
          const status = typeof row.status === "string" ? row.status.trim() : "";
          if (!status) return;
          this._emitState({
            phase: status,
            activeUplink: typeof row.activeUplink === "string" && row.activeUplink ? row.activeUplink : "desktop-ipc",
            reason: typeof row.reason === "string" ? row.reason : "",
          });
        })
      : null;
  }

  async connect() {
    const connected = await this._desktop.runtime.connect();
    this._sessionInfo = {
      accountId: connected && connected.accountId ? connected.accountId : null,
      deviceId: connected && connected.deviceId ? connected.deviceId : null,
      ownerAccountId: connected && connected.ownerAccountId ? connected.ownerAccountId : null,
      localInboxId: connected && connected.localInboxId ? connected.localInboxId : null,
    };
    this._emitState({ phase: "connected", activeUplink: "desktop-ipc" });
  }

  async close() {
    await this._desktop.runtime.disconnect();
    this._emitState({ phase: "disconnected", activeUplink: null });
  }

  async disconnect() {
    await this.close();
  }

  getSessionInfo() {
    if (!this._sessionInfo) return null;
    return {
      accountId: this._sessionInfo.accountId || null,
      deviceId: this._sessionInfo.deviceId || null,
      ownerAccountId: this._sessionInfo.ownerAccountId || null,
      localInboxId: this._sessionInfo.localInboxId || null,
      capabilities: {
        deviceId: this._sessionInfo.deviceId || null,
        localInboxId: this._sessionInfo.localInboxId || null,
      },
    };
  }

  // ---- Generic bus surface (the only way to issue directives) ----

  async call(method, params) {
    return this._desktop.bus.call(method, params || {});
  }

  onEvent(eventName, handler) {
    if (!this._desktop || typeof this._desktop.bus.on !== "function") return () => {};
    return this._desktop.bus.on(eventName, handler);
  }

  on(eventName, handler) {
    return this.onEvent(eventName, handler);
  }

  // ---- Shape adapters (NOT bus directives — kept as named methods) ----

  async sendRezPayload({ threadId, payload, messageId = null, channelId = "" } = {}) {
    return this.call("message.send", {
      threadId,
      payload: coerceRezPayload(payload),
      messageId: typeof messageId === "string" ? messageId : "",
      channelId: typeof channelId === "string" ? channelId.trim() : "",
    });
  }

  // ---- Lifecycle / no-op stubs (transport-specific, not bus directives) ----

  async listInvites() {
    return { body: { items: [] } };
  }

  async putKeystore() {
    return { stored: false, localOnly: true };
  }

  async fetchKeystore() {
    return null;
  }

  get backup() {
    return {
      enable: async () => {
        throw new Error("backup unavailable");
      },
      status: async () => ({ enabled: false, lastBackupAtMs: null, checkpointVersion: null, retentionDays: null }),
      pushDelta: async () => {
        throw new Error("backup unavailable");
      },
      pushCheckpoint: async () => {
        throw new Error("backup unavailable");
      },
      restore: async () => {
        throw new Error("backup unavailable");
      },
    };
  }

  getActiveUplink() {
    return "desktop-ipc";
  }

  getUplinkStates() {
    return [{ url: "desktop-ipc", active: true, ready: true, healthy: true }];
  }

  onState(handler) {
    if (typeof handler !== "function") return () => {};
    this._stateHandlers.push(handler);
    return () => {
      const at = this._stateHandlers.indexOf(handler);
      if (at >= 0) this._stateHandlers.splice(at, 1);
    };
  }

  _emitState(evt) {
    for (const handler of [...this._stateHandlers]) {
      try {
        handler(evt);
      } catch (err) {
        // Subscriber errors are reported (not silently swallowed) but must not
        // halt event delivery to other subscribers.
        if (typeof console !== "undefined" && typeof console.warn === "function") {
          console.warn("[DesktopRuntimeClient] state subscriber failed:", err && err.message ? err.message : err);
        }
      }
    }
  }
}
