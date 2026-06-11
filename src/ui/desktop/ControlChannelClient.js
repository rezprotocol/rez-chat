import { encodeControlValue, decodeControlValue } from "../../desktop/transport/ControlFrameCodec.js";

const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 5000;

/**
 * Browser-side client for the sidecar's /control WebSocket (the Tauri
 * replacement for Electron IPC). One socket per webview; calls made before
 * the hello handshake completes are queued and flushed in order.
 *
 * Frames mirror DesktopControlUplink (src/desktop/transport/):
 *   -> {op:"hello", controlToken}
 *   <- {op:"hello.ok"}
 *   -> {op:"call", id, channel, args}
 *   <- {op:"result", id, ok, payload|error}
 *   <- {op:"event", channel, payload}
 *
 * Reconnects with capped backoff on unexpected close (sidecar restart);
 * in-flight calls reject — callers see the same failure they would have
 * seen from a dead Electron main process. Event subscriptions survive
 * reconnects.
 */
export class ControlChannelClient {
  #url;
  #token;
  #logger;
  #ws;
  #ready;
  #queue;
  #pending;
  #nextId;
  #eventSubscribers;
  #reconnectAttempts;
  #closed;

  constructor({ port, token, host = "127.0.0.1", logger = console } = {}) {
    if (!Number.isInteger(port) || port <= 0) {
      throw new Error("ControlChannelClient requires port");
    }
    if (typeof token !== "string" || token.length === 0) {
      throw new Error("ControlChannelClient requires token");
    }
    this.#url = "ws://" + host + ":" + port + "/control";
    this.#token = token;
    this.#logger = logger || console;
    this.#ws = null;
    this.#ready = false;
    this.#queue = [];
    this.#pending = new Map();
    this.#nextId = 1;
    this.#eventSubscribers = new Set();
    this.#reconnectAttempts = 0;
    this.#closed = false;
    this.#connect();
  }

  /**
   * Invoke a control channel. Resolves with the handler's decoded payload;
   * rejects with an Error carrying `.code` on transport or channel failure.
   * NOTE: vault/runtime/bus channels resolve to `{ok, result|error}`
   * envelopes (the caller unwraps, mirroring preload.cjs); crypto channels
   * resolve to raw values.
   */
  call(channel, args = {}) {
    if (this.#closed) {
      return Promise.reject(this.#transportError("Control channel closed"));
    }
    const id = String(this.#nextId);
    this.#nextId += 1;
    return new Promise((resolve, reject) => {
      const frame = JSON.stringify({
        op: "call",
        id,
        channel,
        args: encodeControlValue(args == null ? {} : args),
      });
      this.#pending.set(id, { resolve, reject });
      if (this.#ready && this.#ws && this.#ws.readyState === WebSocket.OPEN) {
        this.#ws.send(frame);
      } else {
        this.#queue.push(frame);
      }
    });
  }

  /**
   * Subscribe to pushed event frames for one channel (e.g. "bus:event").
   * Returns an unsubscribe function. Survives reconnects.
   */
  onEvent(channel, handler) {
    if (typeof handler !== "function") return () => {};
    const entry = { channel: String(channel == null ? "" : channel), handler };
    this.#eventSubscribers.add(entry);
    return () => {
      this.#eventSubscribers.delete(entry);
    };
  }

  close() {
    this.#closed = true;
    if (this.#ws) {
      try {
        this.#ws.close();
      } catch (err) {
        this.#warn("close failed", err);
      }
    }
    this.#rejectAllPending("Control channel closed");
  }

  #connect() {
    if (this.#closed) return;
    const ws = new WebSocket(this.#url);
    this.#ws = ws;
    this.#ready = false;
    ws.onopen = () => {
      ws.send(JSON.stringify({ op: "hello", controlToken: this.#token }));
    };
    ws.onmessage = (message) => {
      let frame = null;
      try {
        frame = JSON.parse(String(message.data));
      } catch (err) {
        this.#warn("unparseable frame", err);
        return;
      }
      if (!frame || typeof frame !== "object") return;
      if (frame.op === "hello.ok") {
        this.#ready = true;
        this.#reconnectAttempts = 0;
        for (const queued of this.#queue.splice(0)) {
          ws.send(queued);
        }
        return;
      }
      if (frame.op === "result") {
        const pending = this.#pending.get(frame.id);
        if (!pending) return;
        this.#pending.delete(frame.id);
        if (frame.ok === true) {
          pending.resolve(decodeControlValue(frame.payload));
          return;
        }
        const errObj = frame.error && typeof frame.error === "object" ? frame.error : {};
        const err = new Error(typeof errObj.message === "string" ? errObj.message : "Desktop request failed");
        err.code = typeof errObj.code === "string" ? errObj.code : "DESKTOP_IPC_ERROR";
        pending.reject(err);
        return;
      }
      if (frame.op === "event") {
        const payload = decodeControlValue(frame.payload);
        for (const entry of [...this.#eventSubscribers]) {
          if (entry.channel !== frame.channel) continue;
          try {
            entry.handler(payload);
          } catch (err) {
            this.#warn("event subscriber threw", err);
          }
        }
      }
    };
    ws.onclose = () => {
      if (this.#ws !== ws) return;
      this.#ws = null;
      this.#ready = false;
      this.#rejectAllPending("Control channel disconnected");
      if (this.#closed) return;
      const delay = Math.min(
        RECONNECT_BASE_MS * Math.pow(2, this.#reconnectAttempts),
        RECONNECT_MAX_MS,
      );
      this.#reconnectAttempts += 1;
      setTimeout(() => this.#connect(), delay);
    };
    ws.onerror = () => {
      // onclose follows; reconnect handled there.
    };
  }

  #rejectAllPending(message) {
    for (const [, pending] of this.#pending) {
      pending.reject(this.#transportError(message));
    }
    this.#pending.clear();
    this.#queue.length = 0;
  }

  #transportError(message) {
    const err = new Error(message);
    err.code = "CONTROL_CHANNEL_DISCONNECTED";
    return err;
  }

  #warn(message, err) {
    if (this.#logger && typeof this.#logger.warn === "function") {
      this.#logger.warn("[control-channel] " + message, err && err.message ? err.message : err);
    }
  }
}
