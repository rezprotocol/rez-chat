import { WebSocketServer } from "ws";
import { encodeControlValue, decodeControlValue } from "./ControlFrameCodec.js";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

const CLOSE_NOT_AUTHENTICATED = 4401;
const CLOSE_PROTOCOL_ERROR = 4400;

/**
 * WebSocket transport for the desktop control surface (Tauri sidecar).
 *
 * Replaces Electron's `ipcMain.handle(...)` channels with a token-gated WS
 * endpoint at `/control` on the shell HTTP server. The channel semantics are
 * NOT defined here — `registerDesktopRuntimeIpc` (src/desktop/runtime/
 * registerDesktopIpc.js) registers the exact same vault/runtime/bus handlers
 * against `ipcRegistry`, so the Electron IPC path and this WS path share one
 * source of truth. NO per-directive handlers exist on this transport; all
 * chat directives flow through the generic `bus:call` channel. Enforced by
 * test/architecture.no-ipc-facade.test.js.
 *
 * Wire protocol (JSON frames, Uint8Array values tagged via ControlFrameCodec):
 *   client -> server  {op:"hello", controlToken}              first frame, mandatory
 *   server -> client  {op:"hello.ok"}                          on token match
 *   client -> server  {op:"call", id, channel, args}
 *   server -> client  {op:"result", id, ok:true, payload}      payload = handler return
 *   server -> client  {op:"result", id, ok:false, error:{message, code}}
 *   server -> client  {op:"event", channel, payload}           pushed (e.g. bus:event)
 *
 * Handlers registered through `ipcRegistry` keep their Electron semantics:
 * vault/runtime/bus handlers return `{ok, result|error}` envelopes (the shim
 * unwraps them exactly like preload.cjs did); crypto handlers return raw
 * values and signal failure by throwing (carried as op-level ok:false).
 *
 * Auth: `controlToken` is REQUIRED (unlike the chat uplink's optional
 * bridgeToken) — this surface can unlock the vault. The token reaches the
 * webview only via the Tauri initialization script, never over HTTP.
 * Upgrades are restricted to loopback Host plus loopback-or-allowlisted
 * Origin (Tauri webview origins are not loopback: tauri://localhost on
 * macOS/Linux, http://tauri.localhost on Windows).
 */
export class DesktopControlUplink {
  #server;
  #path;
  #controlToken;
  #allowedOrigins;
  #helloTimeoutMs;
  #logger;
  #handlers;
  #wss;
  #upgradeHandler;
  #sessions;

  constructor({
    server,
    controlToken,
    path = "/control",
    allowedOrigins = [],
    helloTimeoutMs = 10000,
    logger = console,
  } = {}) {
    if (!server || typeof server.on !== "function") {
      throw new Error("DesktopControlUplink requires server");
    }
    if (typeof controlToken !== "string" || controlToken.trim().length === 0) {
      throw new Error("DesktopControlUplink requires a non-empty controlToken");
    }
    this.#server = server;
    this.#path = path;
    this.#controlToken = controlToken;
    this.#allowedOrigins = new Set(
      (Array.isArray(allowedOrigins) ? allowedOrigins : [])
        .map((origin) => String(origin || "").trim())
        .filter((origin) => origin.length > 0),
    );
    this.#helloTimeoutMs = helloTimeoutMs;
    this.#logger = logger || console;
    this.#handlers = new Map();
    this.#wss = new WebSocketServer({ noServer: true });
    this.#upgradeHandler = (req, socket, head) => this.#handleUpgrade(req, socket, head);
    this.#sessions = new Map();
  }

  /**
   * ipcMain-compatible registry so `registerDesktopRuntimeIpc` (and the
   * crypto channel registration) work against this transport unchanged.
   */
  get ipcRegistry() {
    const handlers = this.#handlers;
    return {
      handle(channel, handler) {
        const key = String(channel == null ? "" : channel).trim();
        if (!key) throw new Error("DesktopControlUplink.handle requires channel");
        if (typeof handler !== "function") {
          throw new Error("DesktopControlUplink.handle requires handler function");
        }
        if (handlers.has(key)) {
          throw new Error("DesktopControlUplink: duplicate channel '" + key + "'");
        }
        handlers.set(key, handler);
      },
    };
  }

  /**
   * getWindow()-compatible adapter: `webContents.send(channel, payload)`
   * becomes a broadcast to every authenticated control client. Lets
   * `registerDesktopRuntimeIpc` push `bus:event` envelopes without knowing
   * about this transport.
   */
  get windowAdapter() {
    const broadcast = (channel, payload) => this.#broadcast(channel, payload);
    return {
      webContents: {
        send(channel, payload) {
          broadcast(channel, payload);
        },
      },
    };
  }

  get clientCount() {
    return this.#sessions.size;
  }

  start() {
    this.#server.on("upgrade", this.#upgradeHandler);
    this.#wss.on("connection", (ws) => this.#handleConnection(ws));
    return this;
  }

  async close() {
    if (typeof this.#server.off === "function") {
      this.#server.off("upgrade", this.#upgradeHandler);
    } else if (typeof this.#server.removeListener === "function") {
      this.#server.removeListener("upgrade", this.#upgradeHandler);
    }
    for (const [ws, session] of this.#sessions) {
      if (session.helloTimer) clearTimeout(session.helloTimer);
      try {
        ws.close(1001, "server shutdown");
      } catch (err) {
        this.#warn("close failed", err);
      }
    }
    this.#sessions.clear();
    await new Promise((resolve) => {
      this.#wss.close(() => resolve());
    });
  }

  #handleUpgrade(req, socket, head) {
    const pathname = this.#normalizePathname(req.url || "/");
    if (pathname !== this.#path) {
      // Not ours — the chat uplink owns destruction of unknown upgrade paths.
      return;
    }
    if (!this.#isLoopbackHost(req.headers.host)) {
      socket.destroy();
      return;
    }
    const origin = req.headers.origin || "";
    if (origin && !this.#isAllowedOrigin(origin)) {
      socket.destroy();
      return;
    }
    this.#wss.handleUpgrade(req, socket, head, (ws) => {
      this.#wss.emit("connection", ws);
    });
  }

  #handleConnection(ws) {
    const session = { authed: false, helloTimer: null };
    this.#sessions.set(ws, session);
    session.helloTimer = setTimeout(() => {
      session.helloTimer = null;
      if (!session.authed) {
        try {
          ws.close(CLOSE_NOT_AUTHENTICATED, "hello timeout");
        } catch (err) {
          this.#warn("hello-timeout close failed", err);
        }
      }
    }, this.#helloTimeoutMs);
    if (session.helloTimer && typeof session.helloTimer.unref === "function") {
      session.helloTimer.unref();
    }
    ws.on("message", (data) => {
      this.#handleMessage(ws, session, data).catch((err) => {
        this.#warn("message handling failed", err);
      });
    });
    ws.on("close", () => {
      if (session.helloTimer) clearTimeout(session.helloTimer);
      this.#sessions.delete(ws);
    });
    ws.on("error", () => {
      if (session.helloTimer) clearTimeout(session.helloTimer);
      this.#sessions.delete(ws);
    });
  }

  async #handleMessage(ws, session, data) {
    let frame = null;
    try {
      frame = JSON.parse(String(data));
    } catch (err) {
      ws.close(CLOSE_PROTOCOL_ERROR, "invalid frame");
      return;
    }
    if (!frame || typeof frame !== "object" || typeof frame.op !== "string") {
      ws.close(CLOSE_PROTOCOL_ERROR, "invalid frame");
      return;
    }

    if (!session.authed) {
      if (frame.op !== "hello") {
        ws.close(CLOSE_NOT_AUTHENTICATED, "hello required");
        return;
      }
      const token = typeof frame.controlToken === "string" ? frame.controlToken : "";
      if (!this.#tokensMatch(token, this.#controlToken)) {
        ws.close(CLOSE_NOT_AUTHENTICATED, "invalid control token");
        return;
      }
      session.authed = true;
      if (session.helloTimer) {
        clearTimeout(session.helloTimer);
        session.helloTimer = null;
      }
      this.#send(ws, { op: "hello.ok" });
      return;
    }

    if (frame.op !== "call") {
      ws.close(CLOSE_PROTOCOL_ERROR, "unknown op");
      return;
    }
    const id = typeof frame.id === "string" || typeof frame.id === "number" ? frame.id : null;
    if (id === null) {
      ws.close(CLOSE_PROTOCOL_ERROR, "call requires id");
      return;
    }
    const channel = typeof frame.channel === "string" ? frame.channel : "";
    const handler = this.#handlers.get(channel);
    if (!handler) {
      this.#send(ws, {
        op: "result",
        id,
        ok: false,
        error: { message: "Unknown control channel '" + channel + "'", code: "UNKNOWN_CHANNEL" },
      });
      return;
    }
    try {
      const args = decodeControlValue(frame.args == null ? {} : frame.args);
      // First handler arg mirrors Electron's IpcMainInvokeEvent slot; the
      // registered handlers ignore it.
      const payload = await handler(null, args);
      this.#send(ws, { op: "result", id, ok: true, payload: encodeControlValue(payload) });
    } catch (err) {
      this.#send(ws, {
        op: "result",
        id,
        ok: false,
        error: {
          message: err && err.message ? String(err.message) : "Control call failed",
          code: err && err.code ? String(err.code) : "CONTROL_CALL_ERROR",
        },
      });
    }
  }

  #broadcast(channel, payload) {
    const frame = JSON.stringify({
      op: "event",
      channel: String(channel == null ? "" : channel),
      payload: encodeControlValue(payload),
    });
    for (const [ws, session] of this.#sessions) {
      if (!session.authed) continue;
      try {
        ws.send(frame);
      } catch (err) {
        this.#warn("event send failed", err);
      }
    }
  }

  #send(ws, frame) {
    try {
      ws.send(JSON.stringify(frame));
    } catch (err) {
      this.#warn("send failed", err);
    }
  }

  #normalizePathname(urlRaw) {
    try {
      const url = new URL(urlRaw, "http://localhost");
      return url.pathname || "/";
    } catch (err) {
      return "/";
    }
  }

  #isLoopbackHost(hostHeader) {
    if (!hostHeader || typeof hostHeader !== "string") return false;
    const hostname = hostHeader.replace(/:\d+$/, "").toLowerCase();
    return LOOPBACK_HOSTS.has(hostname);
  }

  #isAllowedOrigin(origin) {
    if (!origin || typeof origin !== "string") return false;
    if (this.#allowedOrigins.has(origin.trim())) return true;
    try {
      const url = new URL(origin);
      return LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
    } catch (err) {
      return false;
    }
  }

  #tokensMatch(left, right) {
    return String(left || "") === String(right || "");
  }

  #warn(message, err) {
    if (this.#logger && typeof this.#logger.warn === "function") {
      this.#logger.warn("[control-uplink] " + message, err && err.message ? err.message : err);
    }
  }
}
