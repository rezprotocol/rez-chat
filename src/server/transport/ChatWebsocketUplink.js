import { WebSocketServer } from "ws";
import { BridgeRouter, BridgeResponse, BridgeEvent, BRIDGE_ERROR_CODES } from "@rezprotocol/sdk/client";
import { BridgeClient } from "./BridgeClient.js";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export class ChatWebsocketUplink {
  #server;
  #chatBridge;
  #chatServer;
  #bus;
  #bridgeToken;
  #allowedOrigins;
  #reservedUpgradePaths;
  #logger;
  #router;
  #clients;
  #serverEventUnsubs;
  #bridgeReady;
  #wss;
  #upgradeHandler;

  constructor({
    server,
    chatBridge = null,
    chatServer = null,
    bus = null,
    bridgeToken = "",
    allowedOrigins = [],
    reservedUpgradePaths = [],
    logger = console,
  } = {}) {
    if (!server || typeof server.on !== "function") {
      throw new Error("ChatWebsocketUplink requires server");
    }
    this.#server = server;
    this.#chatServer = chatServer && typeof chatServer === "object" ? chatServer : null;
    this.#chatBridge = chatBridge || (chatServer && chatServer.bridge ? chatServer.bridge : null);
    this.#bus = bus || (chatServer && chatServer.bus ? chatServer.bus : (this.#chatBridge && this.#chatBridge.bus ? this.#chatBridge.bus : null));
    if (this.#chatBridge && typeof this.#chatBridge.getSpec !== "function") {
      throw new Error("ChatWebsocketUplink chatBridge must expose getSpec()");
    }
    if (this.#chatBridge && (!this.#bus || typeof this.#bus !== "object") && (!this.#chatServer || typeof this.#chatServer.on !== "function")) {
      throw new Error("ChatWebsocketUplink requires bus or chatServer event emitter");
    }
    this.#bridgeToken = typeof bridgeToken === "string" ? bridgeToken : "";
    // Non-loopback origins allowed to open this WS (exact-match strings).
    // Tauri webviews send tauri://localhost (macOS/Linux) or
    // http://tauri.localhost (Windows); default behavior stays loopback-only.
    this.#allowedOrigins = new Set(
      (Array.isArray(allowedOrigins) ? allowedOrigins : [])
        .map((origin) => String(origin || "").trim())
        .filter((origin) => origin.length > 0),
    );
    // Upgrade pathnames owned by ANOTHER uplink on the same HTTP server
    // (e.g. the sidecar's /control channel). This uplink must leave those
    // sockets alone instead of destroying them; unknown paths are still
    // destroyed here.
    this.#reservedUpgradePaths = new Set(
      (Array.isArray(reservedUpgradePaths) ? reservedUpgradePaths : [])
        .map((p) => String(p || "").trim())
        .filter((p) => p.length > 0),
    );
    this.#logger = logger || console;
    this.#router = new BridgeRouter();
    if (this.#chatBridge && typeof this.#chatBridge.getSpec === "function") {
      this.#router.register(this.#chatBridge.getSpec());
    }
    this.#clients = new Map();
    this.#serverEventUnsubs = [];
    this.#bridgeReady = false;
    this.#wss = new WebSocketServer({ noServer: true });
    this.#upgradeHandler = (req, socket, head) => this.#handleUpgrade(req, socket, head);
  }

  get ready() {
    return this.#bridgeReady;
  }

  get clients() {
    return this.#clients;
  }

  get router() {
    return this.#router;
  }

  start() {
    this.#server.on("upgrade", this.#upgradeHandler);
    this.#wss.on("connection", (ws) => this.#handleConnection(ws));
    this.#subscribeBridgeEvents();
    return this;
  }

  setReady(flag) {
    this.#bridgeReady = flag === true;
  }

  /**
   * Late-attach a chat-server after `start()`. Used by the deferred-bootstrap
   * path: at boot the shell comes up with no chat-server (so the login UI can
   * render before vault unlock); once the vault unlocks and chat-server has
   * bootstrapped against the BIP39-derived identity, the supervisor calls this
   * to wire bus events through and flip ready=true.
   *
   * Idempotent: re-attaching the same chat-server is a no-op; attaching a new
   * chat-server detaches the old one first.
   */
  attachChatServer(chatServer) {
    if (!chatServer || typeof chatServer !== "object") {
      throw new Error("ChatWebsocketUplink.attachChatServer requires chatServer");
    }
    if (this.#chatServer === chatServer) {
      return;
    }
    if (this.#chatServer != null) {
      this.detachChatServer();
    }
    const bridge = chatServer.bridge && typeof chatServer.bridge.getSpec === "function" ? chatServer.bridge : null;
    if (!bridge) {
      throw new Error("ChatWebsocketUplink.attachChatServer: chatServer.bridge with getSpec() is required");
    }
    const bus = chatServer.bus && typeof chatServer.bus === "object" ? chatServer.bus : null;
    if (!bus && typeof chatServer.on !== "function") {
      throw new Error("ChatWebsocketUplink.attachChatServer: chatServer must expose bus or on/off");
    }
    this.#chatServer = chatServer;
    this.#chatBridge = bridge;
    this.#bus = bus;
    // The shell keeps this uplink alive across logout/login, so a prior
    // attachment leaves its namespace registered on the router. Re-attaching
    // (re-login after logout) MUST start from a clean router — otherwise
    // BridgeRouter.register throws "namespace 'chat' already registered",
    // attachChatServer rejects, startChatServer fails, and the post-relogin
    // runtime never connects (no catch-up, stale roster, dead group delivery).
    this.#router = new BridgeRouter();
    this.#router.register(bridge.getSpec());
    this.#subscribeBridgeEvents();
    this.#bridgeReady = true;
  }

  /**
   * Tear down the current chat-server attachment: unsubscribe events, clear
   * refs, and flip ready=false so in-flight frames get NOT_READY back. Does
   * NOT close client sockets — they stay connected and can re-handshake once
   * a new chat-server attaches.
   */
  detachChatServer() {
    for (const off of this.#serverEventUnsubs.splice(0)) {
      try {
        off();
      } catch (err) {
        if (this.#logger && typeof this.#logger.warn === "function") {
          this.#logger.warn("[uplink] event-unsub failed", err && err.message ? err.message : err);
        }
      }
    }
    this.#chatServer = null;
    this.#chatBridge = null;
    this.#bus = null;
    this.#bridgeReady = false;
  }

  async close() {
    for (const off of this.#serverEventUnsubs.splice(0)) {
      try {
        off();
      } catch {
        // ignore subscriber cleanup failures
      }
    }
    if (typeof this.#server.off === "function") {
      this.#server.off("upgrade", this.#upgradeHandler);
    } else if (typeof this.#server.removeListener === "function") {
      this.#server.removeListener("upgrade", this.#upgradeHandler);
    }
    for (const [, client] of this.#clients) {
      try {
        client.close(1001, "server shutdown");
      } catch {
        // ignore disconnect failures
      }
    }
    this.#clients.clear();
    await new Promise((resolve) => {
      this.#wss.close(() => resolve());
    });
  }

  #subscribeBridgeEvents() {
    if (!this.#chatBridge || typeof this.#chatBridge.getSpec !== "function") return;
    const spec = this.#chatBridge.getSpec();
    const events = spec && spec.events && typeof spec.events === "object" ? spec.events : {};
    for (const eventName of Object.keys(events)) {
      const handler = (record) => {
        this.#broadcastEvent(eventName, record, events[eventName]);
      };
      if (this.#bus && typeof this.#bus.on === "function") {
        const off = this.#bus.on(eventName, handler);
        if (typeof off === "function") {
          this.#serverEventUnsubs.push(off);
        }
        continue;
      }
      if (this.#chatServer && typeof this.#chatServer.on === "function") {
        this.#chatServer.on(eventName, handler);
        this.#serverEventUnsubs.push(() => {
          if (this.#chatServer && typeof this.#chatServer.off === "function") {
            this.#chatServer.off(eventName, handler);
          } else if (this.#chatServer && typeof this.#chatServer.removeListener === "function") {
            this.#chatServer.removeListener(eventName, handler);
          }
        });
      }
    }
  }

  #handleUpgrade(req, socket, head) {
    const pathname = this.#normalizePathname(req.url || "/");
    if (pathname !== "/ws") {
      if (this.#reservedUpgradePaths.has(pathname)) return;
      socket.destroy();
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
      this.#wss.emit("connection", ws, req);
    });
  }

  #handleConnection(ws) {
    const client = new BridgeClient({ ws });
    this.#clients.set(client.id, client);
    ws.on("message", async (data) => {
      await this.#handleMessage(client, ws, data);
    });
    ws.on("close", () => {
      this.#clients.delete(client.id);
    });
    ws.on("error", () => {
      this.#clients.delete(client.id);
    });
  }

  async #handleMessage(client, ws, data) {
    let frame = null;
    try {
      frame = this.#router.parseFrame(String(data));
    } catch (err) {
      this.#sendRawBridgeError(ws, {
        code: BRIDGE_ERROR_CODES.INTERNAL,
        message: this.#toErrorMessage(err),
      });
      return;
    }

    if (frame.type !== "bridge.req") return;
    try {
      if (frame.method !== "session.hello" && client.authenticated !== true) {
        client.sendFrame(this.#buildBridgeErrorResponse(frame, {
          code: BRIDGE_ERROR_CODES.NOT_AUTHENTICATED,
          message: "Not authenticated — send session.hello first",
        }));
        return;
      }
      if (frame.method !== "session.hello" && this.#bridgeReady !== true) {
        client.sendFrame(this.#buildBridgeErrorResponse(frame, {
          code: BRIDGE_ERROR_CODES.NOT_READY,
          message: "Server not ready",
        }));
        return;
      }
      if (frame.method === "session.hello" && this.#bridgeToken) {
        const helloParams = frame.params && typeof frame.params === "object" ? frame.params : {};
        const clientToken = typeof helloParams.bridgeToken === "string" ? helloParams.bridgeToken : "";
        if (!this.#tokensMatch(clientToken, this.#bridgeToken)) {
          client.sendFrame(this.#buildBridgeErrorResponse(frame, {
            code: BRIDGE_ERROR_CODES.NOT_AUTHENTICATED,
            message: "Invalid bridge token",
          }));
          return;
        }
      }
      if (!this.#chatBridge || typeof this.#chatBridge.handle !== "function") {
        client.sendFrame(this.#buildBridgeErrorResponse(frame, {
          code: BRIDGE_ERROR_CODES.INTERNAL,
          message: "No bridge handler",
        }));
        return;
      }
      const params = this.#router.rehydrateParams(frame);
      const result = await this.#chatBridge.handle(client, frame.method, params);
      client.sendFrame(new BridgeResponse({
        ns: frame.ns,
        reqId: frame.reqId,
        ok: true,
        method: frame.method,
        data: result.toJSON(),
      }));
    } catch (err) {
      client.sendFrame(this.#buildBridgeErrorResponse(frame, {
        code: BRIDGE_ERROR_CODES.HANDLER_ERROR,
        message: this.#toErrorMessage(err),
      }));
    }
  }

  #broadcastEvent(eventName, payload, EventClass) {
    const record = payload instanceof EventClass ? payload : new EventClass(payload);
    const eventFrame = new BridgeEvent({
      ns: "chat",
      event: eventName,
      data: record.toJSON(),
    });
    for (const [, client] of this.#clients) {
      if (client.authenticated !== true) continue;
      try {
        client.sendFrame(eventFrame);
      } catch {
        // ignore disconnected clients
      }
    }
  }

  #buildBridgeErrorResponse(frame, error) {
    const ns = frame && typeof frame.ns === "string" ? frame.ns : "";
    const reqId = frame && typeof frame.reqId === "string" ? frame.reqId : "";
    const method = frame && typeof frame.method === "string" ? frame.method : "";
    return new BridgeResponse({
      ns,
      reqId,
      ok: false,
      method,
      error,
    });
  }

  #sendRawBridgeError(ws, error) {
    try {
      ws.send(JSON.stringify({
        type: "bridge.res",
        ns: "",
        reqId: "",
        ok: false,
        method: "",
        data: null,
        error,
      }));
    } catch {
      // ignore closed socket
    }
  }

  #toErrorMessage(err) {
    if (err && typeof err.message === "string" && err.message.trim().length > 0) {
      return err.message;
    }
    return String(err);
  }

  #normalizePathname(urlRaw) {
    try {
      const url = new URL(urlRaw, "http://localhost");
      return url.pathname || "/";
    } catch {
      return "/";
    }
  }

  #isLoopbackHost(hostHeader) {
    if (!hostHeader || typeof hostHeader !== "string") return false;
    const hostname = hostHeader.replace(/:\d+$/, "").toLowerCase();
    return LOOPBACK_HOSTS.has(hostname);
  }

  #isLoopbackOrigin(origin) {
    if (!origin || typeof origin !== "string") return false;
    try {
      const url = new URL(origin);
      return LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
    } catch {
      return false;
    }
  }

  #isAllowedOrigin(origin) {
    if (!origin || typeof origin !== "string") return false;
    if (this.#allowedOrigins.has(origin.trim())) return true;
    return this.#isLoopbackOrigin(origin);
  }

  #tokensMatch(left, right) {
    return String(left || "") === String(right || "");
  }
}
