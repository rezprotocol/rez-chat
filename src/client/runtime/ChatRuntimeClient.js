import { ChatBridgeClient } from "../transport/ChatBridgeClient.js";
import { nonEmptyString } from "../../records/index.js";

function coerceRezPayload(payload) {
  if (payload === null || payload === undefined) return {};
  if (Array.isArray(payload)) return payload;
  if (typeof payload === "object") return payload;
  return { value: payload };
}

/**
 * Browser SDK client.
 *
 * Generic over the bus protocol: `call(method, params)` dispatches via
 * `ChatBridgeClient.call`. UI services consume this through
 * `bus.runtime.client` and call `client.call("namespace.name", params)`.
 *
 * The only named methods are shape adapters (`sendRezPayload`) and
 * transport-specific operations (`sessionHello`, `putKeystore`,
 * `fetchKeystore`, lifecycle, backup). Adding a new bus directive requires
 * zero changes here.
 */
export class ChatRuntimeClient {
  constructor({ wsUrl, accountId, deviceId, bridgeToken, wsFactory = null } = {}) {
    if (typeof wsUrl !== "string" || wsUrl.trim().length === 0) {
      throw new Error("ChatRuntimeClient requires non-empty wsUrl");
    }
    this._wsUrl = wsUrl.trim();
    this._accountId = nonEmptyString(accountId) || null;
    this._deviceId = nonEmptyString(deviceId) || null;
    this._bridgeToken = typeof bridgeToken === "string" ? bridgeToken : "";
    this._bridge = new ChatBridgeClient({ wsUrl: this._wsUrl, wsFactory });
    this._sessionInfo = null;
    this._connected = false;
    this._stateHandlers = [];
    this._bridge.onConnectionState((record) => {
      this._handleConnectionState(record);
    });
  }

  async connect() {
    await this._bridge.connect();
    this._connected = true;
    if (this._accountId && this._deviceId) {
      const result = await this._bridge.sessionHello({
        accountId: this._accountId,
        deviceId: this._deviceId,
        bridgeToken: this._bridgeToken,
      });
      this._sessionInfo = {
        accountId: result.accountId,
        deviceId: result.deviceId,
        ownerAccountId: result.ownerAccountId,
        localInboxId: result.localInboxId || null,
      };
    }
    this._emitState({ phase: "connected", activeUplink: this._wsUrl });
  }

  async close() {
    this._bridge.close();
    this._connected = false;
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
    return this._bridge.call(method, params || {});
  }

  onEvent(eventName, handler) {
    return this._bridge.onEvent(eventName, handler);
  }

  on(eventName, handler) {
    return this.onEvent(eventName, handler);
  }

  // ---- Shape adapters (NOT bus directives) ----

  async sendRezPayload({ threadId, payload, messageId = null, targetCapabilityId = "", channelId = "" } = {}) {
    return this.call("message.send", {
      threadId,
      payload: coerceRezPayload(payload),
      messageId: typeof messageId === "string" ? messageId : "",
      targetCapabilityId: String(targetCapabilityId || ""),
      channelId: typeof channelId === "string" ? channelId.trim() : "",
    });
  }

  // ---- Transport-specific named methods ----

  async putKeystore({ envelope } = {}) {
    if (!this._accountId) {
      throw new Error("putKeystore requires accountId");
    }
    return this._bridge.putKeystore({ accountId: this._accountId, envelope });
  }

  async fetchKeystore({ accountId } = {}) {
    const id = nonEmptyString(accountId) || this._accountId;
    return this._bridge.fetchKeystore({ accountId: id });
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
    return this._wsUrl;
  }

  getUplinkStates() {
    return [{
      url: this._wsUrl,
      active: true,
      ready: this._connected === true,
      healthy: this._connected === true,
    }];
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
        if (typeof console !== "undefined" && typeof console.warn === "function") {
          console.warn("[ChatRuntimeClient] state subscriber failed:", err && err.message ? err.message : err);
        }
      }
    }
  }

  async _reauthenticate() {
    if (!this._accountId || !this._deviceId) return;
    const result = await this._bridge.sessionHello({
      accountId: this._accountId,
      deviceId: this._deviceId,
      bridgeToken: this._bridgeToken,
    });
    this._sessionInfo = {
      accountId: result.accountId,
      deviceId: result.deviceId,
      ownerAccountId: result.ownerAccountId,
      localInboxId: result.localInboxId || null,
    };
    this._connected = true;
  }

  _handleConnectionState(record) {
    const status = nonEmptyString(record && record.status);
    const reason = record && typeof record.reason === "string" ? record.reason : "";
    if (status === "connected") {
      this._reauthenticate().then(() => {
        this._emitState({ phase: "connected", activeUplink: this._wsUrl });
      }).catch((err) => {
        this._connected = false;
        this._emitState({ phase: "disconnected", activeUplink: null, reason: err && err.message ? err.message : "reauth failed" });
      });
      return;
    }
    if (status === "disconnected" || status === "offline") {
      this._connected = false;
    }
    this._emitState({ phase: status || "disconnected", activeUplink: this._wsUrl, reason });
  }
}
