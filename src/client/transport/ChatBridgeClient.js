import { BridgeRouter, BridgeRequest } from "@rezprotocol/sdk/client";
import { CHAT_BRIDGE_SPEC } from "../../server/transport/ChatBridge.js";
import {
  SessionHelloParams,
  KeystorePutParams,
  KeystoreFetchParams,
} from "../../records/index.js";

const REQUEST_TIMEOUT_MS = 30000;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_CAP_MS = 30000;

/**
 * Browser-side WebSocket client for the chat bridge.
 *
 * Generic over the bus protocol: `call(method, params)` constructs the typed
 * param record from `CHAT_BRIDGE_SPEC.methods[method].params` and dispatches
 * via the same `#request` machinery the old named methods used. No
 * per-directive methods — adding a new bus directive requires zero changes
 * here.
 *
 * `sessionHello`, `putKeystore`, and `fetchKeystore` keep their named forms
 * because they have transport-specific semantics (bridge-token handshake +
 * the WS reauth flow). Everything else flows through `call()`.
 */
export class ChatBridgeClient {
  #router;
  #ws;
  #wsUrl;
  #wsFactory;
  #reqIdCounter;
  #pendingRequests;
  #eventSubscribers;
  #connected;
  #intentionallyClosed;
  #reconnectTimer;
  #reconnectAttempts;

  constructor({ wsUrl, wsFactory = null }) {
    if (typeof wsUrl !== "string" || wsUrl.trim().length === 0) {
      throw new Error("ChatBridgeClient requires non-empty wsUrl");
    }
    this.#wsUrl = wsUrl.trim();
    this.#wsFactory = typeof wsFactory === "function" ? wsFactory : null;
    this.#router = new BridgeRouter();
    this.#router.register(CHAT_BRIDGE_SPEC);
    this.#ws = null;
    this.#reqIdCounter = 0;
    this.#pendingRequests = new Map();
    this.#eventSubscribers = new Map();
    this.#connected = false;
    this.#intentionallyClosed = false;
    this.#reconnectTimer = null;
    this.#reconnectAttempts = 0;
  }

  get connected() {
    return this.#connected;
  }

  connect() {
    this.#intentionallyClosed = false;
    this.#reconnectAttempts = 0;
    return this.#connectInternal();
  }

  #connectInternal() {
    return new Promise((resolve, reject) => {
      let ws;
      try {
        ws = this.#openSocket();
      } catch (err) {
        const message = err && typeof err.message === "string" && err.message.trim().length > 0
          ? err.message
          : "WebSocket construction failed";
        reject(new Error(message));
        return;
      }
      this.#ws = ws;

      ws.onopen = () => {
        this.#connected = true;
        this.#reconnectAttempts = 0;
        resolve();
      };

      ws.onerror = () => {
        if (this.#connected !== true) {
          reject(new Error("WebSocket connection failed"));
          return;
        }
        // After connected, errors are handled by onclose
      };

      ws.onclose = () => {
        const wasConnected = this.#connected;
        this.#connected = false;
        this.#rejectAllPending("WebSocket closed");
        if (wasConnected) {
          this.#dispatchEvent("connection.state", { status: "disconnected" });
        }
        if (!this.#intentionallyClosed) {
          this.#scheduleReconnect();
        }
      };

      ws.onmessage = (evt) => {
        this.#handleMessage(typeof evt.data === "string" ? evt.data : String(evt.data));
      };
    });
  }

  #openSocket() {
    if (this.#wsFactory) {
      return this.#wsFactory(this.#wsUrl);
    }
    const WebSocketCtor =
      globalThis && typeof globalThis.WebSocket === "function"
        ? globalThis.WebSocket
        : null;
    if (!WebSocketCtor) {
      throw new Error("ChatBridgeClient requires wsFactory when WebSocket is unavailable");
    }
    return new WebSocketCtor(this.#wsUrl);
  }

  #scheduleReconnect() {
    if (this.#intentionallyClosed) return;
    if (this.#reconnectTimer) return;

    this.#reconnectAttempts += 1;
    const jitter = 0.5 + Math.random();
    const delayMs = Math.min(
      RECONNECT_CAP_MS,
      RECONNECT_BASE_MS * Math.pow(2, this.#reconnectAttempts - 1) * jitter,
    );

    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      if (this.#intentionallyClosed) return;

      this.#connectInternal()
        .then(() => {
          this.#dispatchEvent("connection.state", { status: "connected" });
        })
        .catch((err) => {
          // connectInternal failed — onclose will fire and schedule next attempt
          if (typeof console !== "undefined" && typeof console.warn === "function") {
            console.warn("[ChatBridgeClient] reconnect attempt failed:", err && err.message ? err.message : err);
          }
        });
    }, delayMs);
  }

  close() {
    this.#intentionallyClosed = true;
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    if (this.#ws && typeof this.#ws.close === "function") {
      this.#ws.close(1000, "client close");
    }
    this.#connected = false;
    this.#rejectAllPending("Client closed");
  }

  #handleMessage(raw) {
    let frame;
    try {
      frame = this.#router.parseFrame(raw);
    } catch (err) {
      if (typeof console !== "undefined" && typeof console.warn === "function") {
        console.warn("[ChatBridgeClient] unparseable frame:", err && err.message ? err.message : err);
      }
      return;
    }

    if (frame.type === "bridge.res") {
      this.#handleResponse(frame);
      return;
    }

    if (frame.type === "bridge.evt") {
      this.#handleEvent(frame);
      return;
    }
  }

  #handleResponse(response) {
    const pending = this.#pendingRequests.get(response.reqId);
    if (!pending) return;
    this.#pendingRequests.delete(response.reqId);
    clearTimeout(pending.timer);

    if (response.ok !== true) {
      const errObj = response.error && typeof response.error === "object" ? response.error : {};
      const err = new Error(typeof errObj.message === "string" ? errObj.message : "Bridge request failed");
      err.code = typeof errObj.code === "string" ? errObj.code : "UNKNOWN";
      pending.reject(err);
      return;
    }

    try {
      const result = this.#router.rehydrateResult(response);
      pending.resolve(result);
    } catch (err) {
      pending.reject(err);
    }
  }

  #handleEvent(event) {
    let record;
    try {
      record = this.#router.rehydrateEvent(event);
    } catch (err) {
      if (typeof console !== "undefined" && typeof console.warn === "function") {
        console.warn("[ChatBridgeClient] unknown event " + event.event + ":", err && err.message ? err.message : err);
      }
      return;
    }

    this.#dispatchEvent(event.event, record);
  }

  #dispatchEvent(eventName, record) {
    const handlers = this.#eventSubscribers.get(eventName);
    if (!handlers || handlers.size === 0) return;
    for (const handler of handlers) {
      try {
        handler(record);
      } catch (err) {
        if (typeof console !== "undefined" && typeof console.warn === "function") {
          console.warn("[ChatBridgeClient] event subscriber for " + eventName + " threw:", err && err.message ? err.message : err);
        }
      }
    }
  }

  #request(method, paramsRecord) {
    return new Promise((resolve, reject) => {
      if (this.#connected !== true || this.#ws === null) {
        reject(new Error("Not connected"));
        return;
      }

      const reqId = "r" + (++this.#reqIdCounter);
      const request = new BridgeRequest({
        ns: "chat",
        reqId,
        method,
        params: paramsRecord.toJSON(),
      });

      const timer = setTimeout(() => {
        this.#pendingRequests.delete(reqId);
        reject(new Error("Request timeout for " + method));
      }, REQUEST_TIMEOUT_MS);

      this.#pendingRequests.set(reqId, { resolve, reject, timer, method });

      const json = request.toJSON();
      json.type = request.type;
      this.#ws.send(JSON.stringify(json));
    });
  }

  #rejectAllPending(reason) {
    for (const [, pending] of this.#pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.#pendingRequests.clear();
  }

  // --- Event Subscriptions ---

  onEvent(eventName, handler) {
    if (typeof eventName !== "string" || eventName.length === 0) {
      throw new Error("onEvent requires non-empty eventName");
    }
    if (typeof handler !== "function") {
      throw new Error("onEvent requires handler function");
    }
    let set = this.#eventSubscribers.get(eventName);
    if (!set) {
      set = new Set();
      this.#eventSubscribers.set(eventName, set);
    }
    set.add(handler);
    return () => {
      set.delete(handler);
      if (set.size === 0) {
        this.#eventSubscribers.delete(eventName);
      }
    };
  }

  onConnectionState(handler) {
    return this.onEvent("connection.state", handler);
  }

  // --- Generic dispatch surface (the only way to issue directives) ---

  /**
   * Dispatch one bus directive over the WebSocket. Builds the typed param
   * record from CHAT_BRIDGE_SPEC.methods[method].params so the wire frame
   * always carries the validated shape. Throws if the method is not in the
   * spec.
   */
  async call(method, params) {
    const key = String(method == null ? "" : method).trim();
    const methodSpec = CHAT_BRIDGE_SPEC && CHAT_BRIDGE_SPEC.methods ? CHAT_BRIDGE_SPEC.methods[key] : null;
    if (!methodSpec) {
      throw new Error("ChatBridgeClient: unknown method '" + key + "'");
    }
    const ParamCtor = methodSpec.params;
    const paramsRecord = params instanceof ParamCtor ? params : new ParamCtor(params || {});
    return this.#request(key, paramsRecord);
  }

  // --- Transport-specific named methods (NOT bus directives) ---

  // Bridge-token handshake; gates the WS session before any other request.
  async sessionHello({ accountId, deviceId, bridgeToken }) {
    const params = new SessionHelloParams({ accountId, deviceId, bridgeToken });
    return this.#request("session.hello", params);
  }

  // Keystore methods retain named forms because ChatRuntimeClient injects the
  // bound accountId/defaults into them — UI services do not call these
  // directly with raw {accountId, envelope} pairs.
  async putKeystore({ accountId, envelope }) {
    const params = new KeystorePutParams({ accountId, envelope });
    return this.#request("keystore.put", params);
  }

  async fetchKeystore({ accountId }) {
    const params = new KeystoreFetchParams({ accountId });
    return this.#request("keystore.fetch", params);
  }
}
