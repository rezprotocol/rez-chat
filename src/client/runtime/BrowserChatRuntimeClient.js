import { CHAT_BRIDGE_SPEC } from "../../server/transport/ChatBridge.js";
import { nonEmptyString } from "../../records/index.js";
import { bootstrapBrowserChatRuntime } from "./bootstrapBrowserChatRuntime.js";

function coerceRezPayload(payload) {
  if (payload === null || payload === undefined) return {};
  if (Array.isArray(payload)) return payload;
  if (typeof payload === "object") return payload;
  return { value: payload };
}

export class BrowserChatRuntimeClient {
  #account;
  #uplinks;
  #logger;
  #bootstrapped;
  #connected;
  #eventSubscribers;
  #stateHandlers;
  #runtimeOffs;

  constructor({ account, uplinks, logger = console } = {}) {
    if (!account || typeof account !== "object") {
      throw new Error("BrowserChatRuntimeClient requires account");
    }
    if (!Array.isArray(uplinks) || uplinks.length === 0) {
      throw new Error("BrowserChatRuntimeClient requires uplinks");
    }
    this.#account = account;
    this.#uplinks = uplinks.map((url) => String(url || "").trim()).filter(Boolean);
    this.#logger = logger || console;
    this.#bootstrapped = null;
    this.#connected = false;
    this.#eventSubscribers = new Map();
    this.#stateHandlers = new Set();
    this.#runtimeOffs = [];
  }

  async connect() {
    if (this.#connected) return;
    this.#bootstrapped = await bootstrapBrowserChatRuntime({
      account: this.#account,
      uplinks: this.#uplinks,
      logger: this.#logger,
    });
    this.#bindRuntimeEvents();
    await this.#bootstrapped.chatServer.start();
    this.#connected = true;
    this.#emitState({ phase: "connected", activeUplink: this.getActiveUplink() });
  }

  async close() {
    if (!this.#bootstrapped) return;
    const bootstrapped = this.#bootstrapped;
    await bootstrapped.chatServer.stop();
    for (const off of this.#runtimeOffs.splice(0)) {
      try {
        off();
      } catch (err) {
        this.#logger.warn("[BrowserChatRuntimeClient] event detach failed", err && err.message ? err.message : err);
      }
    }
    this.#bootstrapped = null;
    this.#connected = false;
    this.#emitState({ phase: "disconnected", activeUplink: null });
  }

  async disconnect() {
    await this.close();
  }

  getSessionInfo() {
    if (!this.#bootstrapped) return null;
    const accountId = nonEmptyString(this.#account.accountId);
    const deviceId = nonEmptyString(this.#account.deviceId);
    const localInboxId = this.#bootstrapped.inboxClaimant.inboxId;
    return {
      accountId,
      deviceId,
      ownerAccountId: accountId,
      localInboxId,
      capabilities: { deviceId, localInboxId },
    };
  }

  async call(method, params) {
    if (!this.#connected || !this.#bootstrapped) {
      throw new Error("BrowserChatRuntimeClient is not connected");
    }
    const key = String(method == null ? "" : method).trim();
    const methodSpec = CHAT_BRIDGE_SPEC.methods[key];
    if (!methodSpec) {
      throw new Error("BrowserChatRuntimeClient: unknown method '" + key + "'");
    }
    const ParamCtor = methodSpec.params;
    const paramsRecord = params instanceof ParamCtor ? params : new ParamCtor(params || {});
    return this.#bootstrapped.chatServer.bridge.handle(this.#bridgeClient(), key, paramsRecord);
  }

  onEvent(eventName, handler) {
    const name = String(eventName || "").trim();
    if (!name || typeof handler !== "function") {
      throw new Error("BrowserChatRuntimeClient.onEvent requires eventName and handler");
    }
    let handlers = this.#eventSubscribers.get(name);
    if (!handlers) {
      handlers = new Set();
      this.#eventSubscribers.set(name, handlers);
    }
    handlers.add(handler);
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) this.#eventSubscribers.delete(name);
    };
  }

  on(eventName, handler) {
    return this.onEvent(eventName, handler);
  }

  onState(handler) {
    if (typeof handler !== "function") return () => {};
    this.#stateHandlers.add(handler);
    return () => this.#stateHandlers.delete(handler);
  }

  async sendRezPayload({ threadId, payload, messageId = null, channelId = "" } = {}) {
    return this.call("message.send", {
      threadId,
      payload: coerceRezPayload(payload),
      messageId: typeof messageId === "string" ? messageId : "",
      channelId: typeof channelId === "string" ? channelId.trim() : "",
    });
  }

  async putKeystore({ envelope } = {}) {
    return this.call("keystore.put", {
      accountId: String(this.#account.accountId || "").trim(),
      envelope,
    });
  }

  async fetchKeystore({ accountId } = {}) {
    return this.call("keystore.fetch", {
      accountId: nonEmptyString(accountId) || String(this.#account.accountId || "").trim(),
    });
  }

  get backup() {
    return {
      enable: async () => { throw new Error("backup unavailable"); },
      status: async () => ({ enabled: false, lastBackupAtMs: null, checkpointVersion: null, retentionDays: null }),
      pushDelta: async () => { throw new Error("backup unavailable"); },
      pushCheckpoint: async () => { throw new Error("backup unavailable"); },
      restore: async () => { throw new Error("backup unavailable"); },
    };
  }

  getActiveUplink() {
    const sdk = this.#bootstrapped && this.#bootstrapped.chatServer.sdk;
    if (sdk && typeof sdk.getActiveUplink === "function") return sdk.getActiveUplink();
    return this.#uplinks[0] || null;
  }

  getUplinkStates() {
    const sdk = this.#bootstrapped && this.#bootstrapped.chatServer.sdk;
    if (sdk && typeof sdk.getUplinkStates === "function") return sdk.getUplinkStates();
    return this.#uplinks.map((url) => ({
      url,
      active: url === this.getActiveUplink(),
      ready: this.#connected,
      healthy: this.#connected,
    }));
  }

  #bridgeClient() {
    const expectedAccountId = String(this.#account.accountId || "").trim();
    const expectedDeviceId = String(this.#account.deviceId || "").trim();
    return {
      authenticate({ accountId, deviceId } = {}) {
        if (accountId !== expectedAccountId || deviceId !== expectedDeviceId) {
          throw new Error("BrowserChatRuntimeClient session identity mismatch");
        }
      },
    };
  }

  #bindRuntimeEvents() {
    const server = this.#bootstrapped.chatServer;
    for (const eventName of Object.keys(CHAT_BRIDGE_SPEC.events)) {
      this.#runtimeOffs.push(server.on(eventName, (record) => this.#dispatchEvent(eventName, record)));
    }
    const sdk = server.sdk;
    if (sdk && typeof sdk.onState === "function") {
      this.#runtimeOffs.push(sdk.onState((state) => this.#emitState(state)));
    }
  }

  #dispatchEvent(eventName, record) {
    const handlers = this.#eventSubscribers.get(eventName);
    if (!handlers) return;
    for (const handler of [...handlers]) {
      try {
        handler(record);
      } catch (err) {
        this.#logger.warn("[BrowserChatRuntimeClient] event subscriber failed", err && err.message ? err.message : err);
      }
    }
  }

  #emitState(state) {
    for (const handler of [...this.#stateHandlers]) {
      try {
        handler(state);
      } catch (err) {
        this.#logger.warn("[BrowserChatRuntimeClient] state subscriber failed", err && err.message ? err.message : err);
      }
    }
  }
}
