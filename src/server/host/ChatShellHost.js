import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { ChatWebsocketUplink } from "../transport/ChatWebsocketUplink.js";

const MIME_BY_EXT = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export class ChatShellHost {
  #uiRoot;
  #resolvedUplinks;
  #warmSpareCount;
  #e2eDebug;
  #chatBackupV1;
  #port;
  #host;
  #skipUiRootCheck;
  #chatBridge;
  #chatServer;
  #bridgeToken;
  #allowedOrigins;
  #reservedUpgradePaths;
  #healthInfo;
  #logger;
  #server;
  #bridge;
  #address;

  constructor({
    uiRoot,
    wsUrl,
    uplinks = null,
    warmSpareCount = 2,
    e2eDebug = false,
    chatBackupV1 = false,
    port = 3000,
    host = "127.0.0.1",
    skipUiRootCheck = false,
    chatBridge = null,
    chatServer = null,
    bridgeToken = "",
    allowedOrigins = [],
    reservedUpgradePaths = [],
    healthInfo = null,
    logger = console,
  } = {}) {
    if (!uiRoot) throw new Error("ChatShellHost requires uiRoot");
    this.#uiRoot = uiRoot;
    this.#resolvedUplinks = this.#resolveUplinks({ wsUrl, uplinks });
    if (this.#resolvedUplinks.length === 0) {
      throw new Error("ChatShellHost requires wsUrl or uplinks");
    }
    this.#warmSpareCount = warmSpareCount;
    this.#e2eDebug = e2eDebug === true;
    this.#chatBackupV1 = chatBackupV1 === true;
    this.#port = port;
    this.#host = host;
    this.#skipUiRootCheck = skipUiRootCheck === true;
    this.#chatServer = chatServer;
    this.#chatBridge = chatBridge || (chatServer && chatServer.bridge ? chatServer.bridge : null);
    this.#bridgeToken = typeof bridgeToken === "string" ? bridgeToken : "";
    this.#allowedOrigins = Array.isArray(allowedOrigins) ? allowedOrigins : [];
    this.#reservedUpgradePaths = Array.isArray(reservedUpgradePaths) ? reservedUpgradePaths : [];
    // Extra fields merged into the /health response (object or function).
    // The Tauri sidecar reports {sidecar:true, instanceId} here so the
    // InstanceLock stale-cleanup can verify a lock's owner before killing.
    this.#healthInfo = healthInfo;
    this.#logger = logger || console;
    this.#server = null;
    this.#bridge = null;
    this.#address = { host: this.#host, port: this.#port };
  }

  get server() {
    return this.#server;
  }

  get bridge() {
    return this.#bridge;
  }

  get address() {
    return this.#address;
  }

  async start() {
    await this.#assertUiRoot();
    this.#server = createServer((req, res) => {
      this.#handleRequest(req, res).catch(() => {
        res.writeHead(500);
        res.end();
      });
    });
    await new Promise((resolve, reject) => {
      this.#server.listen(this.#port, this.#host, (err) => {
        if (err) reject(err);
        else resolve();
      });
      this.#server.once("error", reject);
    });
    this.#bridge = new ChatWebsocketUplink({
      server: this.#server,
      chatBridge: this.#chatBridge,
      chatServer: this.#chatServer,
      bridgeToken: this.#bridgeToken,
      allowedOrigins: this.#allowedOrigins,
      reservedUpgradePaths: this.#reservedUpgradePaths,
      logger: this.#logger,
    }).start();
    this.#address = this.#getAddress(this.#server);
    return this;
  }

  async stop() {
    if (this.#bridge) {
      await this.#bridge.close();
      this.#bridge = null;
    }
    if (this.#server) {
      const server = this.#server;
      this.#server = null;
      await new Promise((resolve) => server.close(resolve));
    }
  }

  /**
   * Late-attach a chat-server to the running shell's WS uplink. Used by the
   * deferred-bootstrap path so the shell can serve the login UI before the
   * vault is unlocked, then have chat-server wired through after unlock.
   */
  attachChatServer(chatServer) {
    if (!this.#bridge) throw new Error("ChatShellHost.attachChatServer: shell not started");
    this.#chatServer = chatServer;
    this.#chatBridge = chatServer && chatServer.bridge ? chatServer.bridge : null;
    this.#bridge.attachChatServer(chatServer);
  }

  detachChatServer() {
    if (!this.#bridge) return;
    this.#bridge.detachChatServer();
    this.#chatServer = null;
    this.#chatBridge = null;
  }

  async #assertUiRoot() {
    if (this.#skipUiRootCheck) return;
    const indexPath = path.resolve(this.#uiRoot, "index.html");
    try {
      const indexContent = await fs.readFile(indexPath, "utf8");
      if (/src\/main\.js|src\/index\.js|\/src\//.test(indexContent)) {
        throw new Error("uiRoot points to Vite source; build rez-chat and point to artifacts/rez-chat (or set CHAT_UI_ROOT)");
      }
    } catch (err) {
      if (err && err.code === "ENOENT") {
        throw new Error("rez-chat uiRoot missing index.html at " + indexPath + ". Build rez-chat (npm run build) and point uiRoot at artifacts/rez-chat (or set CHAT_UI_ROOT).");
      }
      throw err;
    }
  }

  async #handleRequest(req, res) {
    if (!this.#isLoopbackHost(req.headers.host)) {
      res.writeHead(403);
      res.end();
      return;
    }
    const nonce = randomBytes(16).toString("base64");
    const securityHeaders = this.#buildSecurityHeaders(nonce);
    const pathname = this.#normalizePathname(req.url || "/");
    if (pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json", ...securityHeaders });
      res.end(JSON.stringify({ ok: true, tsMs: Date.now(), ...this.#resolveHealthInfo() }));
      return;
    }
    if ((pathname === "/keystore/put" || pathname === "/keystore/fetch") && req.method === "POST") {
      res.writeHead(410, { "content-type": "application/json", ...securityHeaders });
      res.end(JSON.stringify({ ok: false, error: "HTTP keystore endpoints removed — use WS bridge" }));
      return;
    }
    if (pathname === "/config") {
      res.writeHead(200, { "content-type": "application/json", ...securityHeaders });
      res.end(JSON.stringify(this.#buildConfigPatch(false)));
      return;
    }

    const relPath = pathname === "/" ? "index.html" : pathname.slice(1);
    const resolvedPath = path.resolve(this.#uiRoot, relPath);
    const resolvedUiRoot = path.resolve(this.#uiRoot);
    if (!resolvedPath.startsWith(resolvedUiRoot)) {
      res.writeHead(403, securityHeaders);
      res.end();
      return;
    }

    const stat = await fs.stat(resolvedPath).catch(() => null);
    if (!stat || !stat.isFile()) {
      res.writeHead(404, securityHeaders);
      res.end();
      return;
    }

    const realPath = await fs.realpath(resolvedPath).catch(() => null);
    const realUiRoot = await fs.realpath(resolvedUiRoot).catch(() => resolvedUiRoot);
    if (!realPath || !realPath.startsWith(realUiRoot)) {
      res.writeHead(403, securityHeaders);
      res.end();
      return;
    }

    const ext = path.extname(resolvedPath).toLowerCase();
    const contentType = MIME_BY_EXT[ext] || "application/octet-stream";
    if (ext === ".html") {
      const html = await fs.readFile(resolvedPath, "utf8");
      const injected = this.#injectConfig(html, this.#buildConfigPatch(true), nonce);
      res.writeHead(200, { "content-type": contentType, ...securityHeaders });
      res.end(injected);
      return;
    }

    const bytes = await fs.readFile(resolvedPath);
    res.writeHead(200, { "content-type": contentType, ...securityHeaders });
    res.end(bytes);
  }

  #buildConfigPatch(includeBridgeToken) {
    const patch = {
      wsUrl: this.#resolvedUplinks[0] || null,
      uplinks: this.#resolvedUplinks,
      warmSpareCount: this.#warmSpareCount,
      features: {
        chatBackupV1: this.#chatBackupV1,
      },
      e2eDebug: this.#e2eDebug,
    };
    if (includeBridgeToken === true && this.#bridgeToken) {
      patch.bridgeToken = this.#bridgeToken;
    }
    return patch;
  }

  #buildSecurityHeaders(nonce) {
    const csp = [
      "default-src 'self'",
      "script-src 'self' 'nonce-" + nonce + "'",
      "script-src-elem 'self' 'nonce-" + nonce + "'",
      "style-src 'self' 'unsafe-inline'",
      "font-src 'self'",
      "connect-src 'self' ws: wss:",
      "img-src 'self' data:",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; ");
    return {
      "content-security-policy": csp,
      "x-frame-options": "DENY",
      "x-content-type-options": "nosniff",
    };
  }

  #resolveHealthInfo() {
    if (typeof this.#healthInfo === "function") {
      try {
        const info = this.#healthInfo();
        return info && typeof info === "object" ? info : {};
      } catch (err) {
        if (this.#logger && typeof this.#logger.warn === "function") {
          this.#logger.warn("[shell] healthInfo provider failed", err && err.message ? err.message : err);
        }
        return {};
      }
    }
    if (this.#healthInfo && typeof this.#healthInfo === "object") {
      return this.#healthInfo;
    }
    return {};
  }

  #normalizePathname(urlRaw) {
    try {
      const url = new URL(urlRaw, "http://localhost");
      return url.pathname || "/";
    } catch {
      return "/";
    }
  }

  #injectConfig(html, configPatch, nonce) {
    const debugScript = configPatch && configPatch.e2eDebug === true
      ? "globalThis.__REZ_E2E_DEBUG__ = true;"
      : "";
    const nonceAttr = nonce ? ' nonce="' + nonce + '"' : "";
    const script = "<script" + nonceAttr + ">globalThis.__REZ_SHELL_CONFIG__ = " + JSON.stringify(configPatch) + ";globalThis.REZ_CONFIG = Object.assign({}, globalThis.REZ_CONFIG || {}, globalThis.__REZ_SHELL_CONFIG__);" + debugScript + "</script>";
    if (html.indexOf("</head>") >= 0) {
      return html.replace("</head>", script + "\n</head>");
    }
    return script + "\n" + html;
  }

  #resolveUplinks({ wsUrl, uplinks }) {
    if (Array.isArray(uplinks)) {
      const list = uplinks.map((value) => String(value || "").trim()).filter(Boolean);
      if (list.length > 0) return list;
    }
    if (typeof wsUrl === "string" && wsUrl.trim().length > 0) {
      return [wsUrl.trim()];
    }
    return [];
  }

  #getAddress(server) {
    const addr = server.address();
    if (!addr || typeof addr === "string") return { host: "127.0.0.1", port: 0 };
    return { host: addr.address, port: addr.port };
  }

  #isLoopbackHost(hostHeader) {
    if (!hostHeader || typeof hostHeader !== "string") return false;
    const hostname = hostHeader.replace(/:\d+$/, "").toLowerCase();
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "[::1]";
  }
}
