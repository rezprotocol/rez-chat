import { BaseBusService } from "./BaseBusService.js";
import { CHAT_BRIDGE_SPEC } from "../../../server/transport/ChatBridge.js";

const RUNTIME_EVENTS_HANDLED_SEPARATELY = new Set(["mesh.updated"]);

function hasMeshSnapshot(status) {
  return !!(status && status.mesh && typeof status.mesh === "object");
}

export class RuntimeService extends BaseBusService {
  constructor({ bus, sdkSessionService, connectionStore, logger = console } = {}) {
    super({ bus });
    if (!sdkSessionService || !connectionStore) {
      throw new Error("RuntimeService requires sdkSessionService and connectionStore");
    }
    this._sdkSessionService = sdkSessionService;
    this._connectionStore = connectionStore;
    this._logger = logger;
    this._client = null;
    this._clientOffs = [];
    this._readyPromise = null;
    this._readyResolver = null;
    this._readyRejecter = null;
    this._runtimeReady = false;
    this._pendingRuntimeEvents = [];
    this._register("runtime", "connect", () => this.connect());
    this._register("runtime", "disconnect", () => this.disconnect());
  }

  async connect() {
    const connected = await this._sdkSessionService.connectClient();
    const client = this._sdkSessionService.getClient();
    if (!client) {
      throw new Error("RuntimeService connect did not produce a client");
    }
    this._bindClient(client);
    this._client = client;
    this.bus.runtime.client = client;
    this._runtimeReady = false;
    this._pendingRuntimeEvents = [];
    const readyState = await this._ensureReady(client);
    return {
      ...connected,
      mesh: readyState && readyState.mesh ? readyState.mesh : null,
    };
  }

  async disconnect() {
    const client = this._client;
    const sessionStore = this.bus.stores && this.bus.stores.session ? this.bus.stores.session : null;
    if (sessionStore && typeof sessionStore.setInitStep === "function") {
      sessionStore.setInitStep(null);
    }
    this._clearReadyWait();
    this._runtimeReady = false;
    this._pendingRuntimeEvents = [];
    for (const off of this._clientOffs.splice(0)) {
      try {
        off();
      } catch {
        // ignore teardown failures
      }
    }
    await this._sdkSessionService.disconnect().catch((err) => {
      console.error("[RuntimeService] disconnect during teardown failed", err);
      this.bus.emit("app.error", { source: "RuntimeService", message: "disconnect during teardown failed", severity: "info", err });
    });
    this._client = null;
    this.bus.runtime.client = null;
    this._connectionStore.setConnection({
      status: "disconnected",
      activeNode: "",
      nodes: [],
    });
    this.bus.emit("runtime.disconnected", {});
  }

  _bindClient(client) {
    for (const off of this._clientOffs.splice(0)) {
      try {
        off();
      } catch {
        // ignore teardown failures
      }
    }
    this._clientOffs.push(client.onState((evt) => {
      const phase = evt && evt.phase ? String(evt.phase).toLowerCase() : "";
      if (phase === "connected") {
        this._ensureReady(client).catch((err) => {
          if (this._logger && typeof this._logger.warn === "function") {
            this._logger.warn("RuntimeService readiness failed after reconnect", err && err.message ? err.message : err);
          }
        });
        return;
      }
      const status = phase === "offline" ? "offline"
        : phase === "reconnecting" ? "reconnecting"
        : phase === "failover" ? "connecting"
        : phase === "connecting" ? "connecting"
        : phase === "authenticating" ? "connecting"
        : "disconnected";
      const teardown = status === "offline" || status === "disconnected";
      if (teardown) {
        this._clearReadyWait(new Error("Runtime " + status + " before ready"));
        this._readyPromise = null;
        this._runtimeReady = false;
        this._pendingRuntimeEvents = [];
      }
      this._connectionStore.setConnection({
        status,
        activeNode: typeof client.getActiveUplink === "function" ? client.getActiveUplink() : "",
        nodes: typeof client.getUplinkStates === "function" ? client.getUplinkStates() : [],
        lastError: evt && evt.reason ? String(evt.reason) : null,
      });
      if (teardown) {
        this.bus.emit("runtime.disconnected", evt || {});
      } else {
        this.bus.emit("runtime.connection.changed", { status, evt: evt || null });
      }
    }));
    for (const eventName of Object.keys(CHAT_BRIDGE_SPEC.events || {})) {
      if (RUNTIME_EVENTS_HANDLED_SEPARATELY.has(eventName)) continue;
      this._bindEvent(client, eventName, "runtime.event." + eventName);
    }
    this._clientOffs.push(client.onEvent("mesh.updated", (record) => {
      this._handleMeshUpdated(client, record);
    }));
  }

  _bindEvent(client, clientEventName, busEventName) {
    this._clientOffs.push(client.onEvent(clientEventName, (record) => {
      if (this._runtimeReady !== true) {
        this._pendingRuntimeEvents.push({ busEventName, record });
        return;
      }
      this.bus.emit(busEventName, record);
    }));
  }

  async _ensureReady(client) {
    if (this._runtimeReady === true) {
      return this._connectionStore.getConnection();
    }
    const sessionStore = this.bus.stores && this.bus.stores.session ? this.bus.stores.session : null;
    if (sessionStore && typeof sessionStore.setInitStep === "function") {
      sessionStore.setInitStep("CONNECTING_TO_REZNET");
    }
    const connectingState = {
      status: "connecting",
      activeNode: typeof client.getActiveUplink === "function" ? client.getActiveUplink() : "",
      nodes: typeof client.getUplinkStates === "function" ? client.getUplinkStates() : [],
      lastError: null,
    };
    this._connectionStore.setConnection(connectingState);
    this.bus.emit("runtime.connecting", connectingState);
    this._seedMeshStatus(client);
    const current = this._connectionStore.getConnection();
    const readyState = {
      status: "connected",
      activeNode: typeof client.getActiveUplink === "function" ? client.getActiveUplink() : "",
      nodes: typeof client.getUplinkStates === "function" ? client.getUplinkStates() : [],
      mesh: hasMeshSnapshot(current) ? current.mesh : null,
      lastError: null,
    };
    this._connectionStore.setConnection(readyState);
    if (sessionStore && typeof sessionStore.setInitStep === "function") {
      sessionStore.setInitStep("REZNET_READY");
    }
    this._runtimeReady = true;
    this._flushPendingRuntimeEvents();
    if (this.bus.resolveReady && typeof this.bus.resolveReady.runtime === "function") {
      this.bus.resolveReady.runtime();
    }
    this.bus.emit("runtime.connected", readyState);
    this.bus.emit("runtime.ready", readyState);
    return readyState;
  }

  _seedMeshStatus(client) {
    const request = typeof client.call === "function"
      ? client.call("mesh.status", {})
      : Promise.resolve(null);
    request.then((status) => {
      if (this._client !== client) {
        return;
      }
      this._handleMeshUpdated(client, status);
    }).catch((err) => {
      if (this._logger && typeof this._logger.warn === "function") {
        this._logger.warn("RuntimeService initial mesh status failed", err && err.message ? err.message : err);
      }
    });
  }

  _handleMeshUpdated(client, record) {
    if (this._client !== client) {
      return;
    }
    const payload = record && typeof record === "object" ? record : null;
    const mesh = payload && payload.mesh && typeof payload.mesh === "object" ? payload.mesh : null;
    if (!mesh) {
      return;
    }
    this.bus.emit("runtime.mesh.updated", payload);
    const current = this._connectionStore.getConnection();
    this._connectionStore.setConnection({
      status: current && current.status ? current.status : "connected",
      activeNode: typeof client.getActiveUplink === "function" ? client.getActiveUplink() : "",
      nodes: typeof client.getUplinkStates === "function" ? client.getUplinkStates() : [],
      mesh,
      lastError: null,
    });
  }

  _clearReadyWait() {
    this._readyPromise = null;
    this._readyResolver = null;
    this._readyRejecter = null;
  }

  _flushPendingRuntimeEvents() {
    const pending = this._pendingRuntimeEvents.splice(0);
    for (const entry of pending) {
      if (!entry || typeof entry !== "object") continue;
      const busEventName = typeof entry.busEventName === "string" ? entry.busEventName : "";
      if (!busEventName) continue;
      this.bus.emit(busEventName, entry.record);
    }
  }

  stop() {
    this.disconnect().catch((err) => {
      if (this._logger && typeof this._logger.warn === "function") {
        this._logger.warn("RuntimeService stop failed", err && err.message ? err.message : err);
      }
    });
    super.stop();
  }
}
