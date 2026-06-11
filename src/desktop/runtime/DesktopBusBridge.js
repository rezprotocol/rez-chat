import { CHAT_BRIDGE_SPEC, ChatBridge } from "../../server/transport/index.js";

/**
 * Generic IPC dispatcher for the desktop transport.
 *
 * Mirrors what `ChatBridge` (WS path) does for `ChatWebsocketUplink`: one
 * entry point `call(method, params)` dispatches by iterating
 * `CHAT_BRIDGE_METHOD_BINDINGS`; one subscription pump iterates
 * `CHAT_BRIDGE_SPEC.events` and forwards each event verbatim. No bus
 * directive is enumerated anywhere — adding a directive requires zero
 * changes in this file.
 *
 * Constructed by `DesktopSupervisor.connect()` once the chat-server is up;
 * torn down by `DesktopSupervisor.disconnect()`. The IPC layer
 * (`registerDesktopRuntimeIpc`) wires `ipcMain.handle("bus:call", ...)` to
 * this.call and `subscribeEvents(...)` to `webContents.send("bus:event", ...)`.
 */
export class DesktopBusBridge {
  #chatBridge;
  #bus;
  #client;
  #spec;
  #unsubs;

  constructor({ chatApp } = {}) {
    if (!chatApp || !chatApp.chatServer || !chatApp.chatServer.bus) {
      throw new Error("DesktopBusBridge requires chatApp.chatServer.bus");
    }
    this.#bus = chatApp.chatServer.bus;
    // Reuse the chat-server's existing bridge instance when available so the
    // dispatch table and any future per-method gating stay symmetric across
    // transports. Fall back to a fresh instance bound to the same bus.
    this.#chatBridge = chatApp.chatServer.bridge instanceof ChatBridge
      ? chatApp.chatServer.bridge
      : new ChatBridge({ bus: this.#bus, ownerAccountId: chatApp.chatServer.ownerAccountId });
    this.#client = new DesktopIpcBridgeClient();
    this.#spec = this.#chatBridge.getSpec();
    this.#unsubs = [];
  }

  /**
   * Dispatch one bus directive. Builds the typed param record from the spec
   * so transports and the in-process bus see the same validated shapes.
   */
  async call(method, params) {
    const key = String(method == null ? "" : method).trim();
    const methodSpec = this.#spec && this.#spec.methods ? this.#spec.methods[key] : null;
    if (!methodSpec) {
      throw new Error("DesktopBusBridge: unknown method '" + key + "'");
    }
    const ParamCtor = methodSpec.params;
    const paramsRecord = params instanceof ParamCtor ? params : new ParamCtor(params || {});
    const result = await this.#chatBridge.handle(this.#client, key, paramsRecord);
    return result && typeof result.toJSON === "function" ? result.toJSON() : result;
  }

  /**
   * Subscribe to every event in CHAT_BRIDGE_SPEC.events and forward verbatim.
   * `emit({ event, payload })` is called once per fired event. Returns an
   * unsubscribe that releases ONLY the subscriptions registered by this call
   * — multiple subscribers (e.g. one per waiting promise in tests) do not
   * cross-cancel.
   */
  subscribeEvents(emit) {
    if (typeof emit !== "function") {
      throw new Error("DesktopBusBridge.subscribeEvents requires emit function");
    }
    const events = this.#spec && this.#spec.events && typeof this.#spec.events === "object"
      ? this.#spec.events
      : {};
    const localUnsubs = [];
    for (const eventName of Object.keys(events)) {
      const EventClass = events[eventName];
      const off = this.#bus.on(eventName, (payload) => {
        const record = payload instanceof EventClass ? payload : new EventClass(payload);
        emit({ event: eventName, payload: record.toJSON() });
      });
      if (typeof off === "function") {
        localUnsubs.push(off);
        this.#unsubs.push(off);
      }
    }
    return () => {
      for (const off of localUnsubs.splice(0)) {
        // Also remove from the bridge-wide list so close() doesn't double-call.
        const idx = this.#unsubs.indexOf(off);
        if (idx >= 0) this.#unsubs.splice(idx, 1);
        try {
          off();
        } catch (err) {
          if (typeof console !== "undefined" && typeof console.warn === "function") {
            console.warn("[DesktopBusBridge] subscriber unsubscribe failed:", err && err.message ? err.message : err);
          }
        }
      }
    };
  }

  close() {
    for (const off of this.#unsubs.splice(0)) {
      try { off(); } catch (err) {
        // unsubscribe failure does not block teardown; the bus is being torn
        // down with the chat-server immediately after.
        if (typeof console !== "undefined" && typeof console.warn === "function") {
          console.warn("[DesktopBusBridge] unsubscribe failed:", err && err.message ? err.message : err);
        }
      }
    }
  }
}

/**
 * Minimal client stand-in for `ChatBridge.handle()` on the IPC transport.
 * The WS transport has per-connection auth gated on `session.hello`; the
 * desktop transport runs in-process, gated upstream by the vault and the
 * supervisor's `connect()` lifecycle. So we mark the client as already
 * authenticated and supply a no-op `authenticate()` for the one branch in
 * `ChatBridge.handle()` that calls it.
 */
class DesktopIpcBridgeClient {
  get authenticated() {
    return true;
  }

  authenticate(_info) {
    // no-op: desktop has no per-session auth
  }
}
