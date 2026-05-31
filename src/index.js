import path from "node:path";
import fs from "node:fs";
import { randomBytes } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startRezNode } from "@rezprotocol/node";
import { loadRezConfig, ChatShellHost, bootstrapChatServer } from "./server/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHAT_ROOT = path.resolve(__dirname, "..");
const DEFAULT_UI_ROOT = path.resolve(CHAT_ROOT, "artifacts/rez-chat");
const DEFAULT_NODE_DATA_DIR = path.join(".local", "rez-node-data");
const SHELL_PORT = parseInt(process.env.CHAT_PORT || "3000", 10);
const SHELL_HOST = process.env.CHAT_BIND_HOST || "127.0.0.1";

function timestampText() {
  const now = new Date();
  const pad = (value, size = 2) => String(value).padStart(size, "0");
  return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`;
}

function chatLog(method, ...args) {
  const writer = console && typeof console[method] === "function" ? console[method] : console.log;
  writer(`${timestampText()} [rez-chat]`, ...args);
}

export async function startRezChat(options = {}) {
  const configPathOverride = options.configPath ?? process.env.REZ_CHAT_CONFIG_PATH ?? null;
  const { config, configPath, created } = await loadRezConfig({ cwd: CHAT_ROOT, configPath: configPathOverride });
  if (!config.node || typeof config.node !== "object") config.node = {};
  if (!config.node.ws || typeof config.node.ws !== "object") config.node.ws = {};
  if (!config.node.storage || typeof config.node.storage !== "object") config.node.storage = {};
  if (!config.node.ws.host) {
    config.node.ws.host = process.env.NODE_WS_HOST || "127.0.0.1";
  }

  const dataDirOverride = process.env.REZ_NODE_DATA_DIR ?? null;
  if (typeof dataDirOverride === "string" && dataDirOverride.trim().length > 0) {
    config.node.storage.dataDir = dataDirOverride.trim();
  } else {
    const originalDataDir = config.node.storage.dataDir;
    const resolvedDataDir = resolveConfiguredDataDir({ dataDir: originalDataDir, configPath });
    if (
      typeof originalDataDir === "string" &&
      path.isAbsolute(originalDataDir.trim()) &&
      path.normalize(originalDataDir.trim()) !== path.normalize(resolvedDataDir)
    ) {
      chatLog("warn", `remapping node.storage.dataDir to ${resolvedDataDir}`);
    }
    config.node.storage.dataDir = resolvedDataDir;
  }
  config.node.storage.defaultThreadId = coerceDefaultThreadId(config.node.storage.defaultThreadId);

  const wsPortSource = process.env.REZ_NODE_WS_PORT ?? null;
  if (wsPortSource != null && String(wsPortSource).trim().length > 0) {
    const parsedPort = Number.parseInt(String(wsPortSource), 10);
    if (!Number.isInteger(parsedPort) || parsedPort <= 0) {
      throw new Error(`Invalid REZ_NODE_WS_PORT: ${wsPortSource}`);
    }
    config.node.ws.port = parsedPort;
  }

  const envUiRoot = resolveUiRoot(process.env.CHAT_UI_ROOT);
  const uiRoot = options.uiRoot ?? envUiRoot ?? DEFAULT_UI_ROOT;
  const skipUiRootCheck = options.skipUiRootCheck === true;
  if (!skipUiRootCheck && !fs.existsSync(uiRoot)) {
    throw new Error(
      `rez-chat UI bundle missing at ${uiRoot}. Run: npm -w rez-chat run build OR start rez-chat with skipUiRootCheck=true`,
    );
  }

  const nodeApp = await startRezNode(config);
  const wsUrl = buildWsUrl(config);

  // --- ChatServerApp (server-side chat logic using SDK) ---
  //
  // chat-server gets its OWN FsStorageProvider AND its OWN account-level
  // identity, both separate from the node's. This is the data-split
  // foundation for Shape A (see docs/HOSTED_NODE_DESIGN.md §10).
  //
  // Identity: chat-server generates an ed25519 keypair on first boot and
  // persists it in chat-server's storage. The account ID derives from
  // chat-server's pubkey, NOT from the node's. The node has its own
  // separate keypair for its routing/network role. In a hosted-node
  // deployment, chat-server's private key never reaches the operator —
  // only its pubkey, and only as the verifiable claim in session.hello.
  //
  // Storage: chat-server data lives in its own FsStorageProvider under
  // <dataDir>/chat-server. Encryption key is derived from chat-server's
  // OWN private key (not the node's), so a hosted-node operator with disk
  // access to the node's data dir cannot decrypt chat-server's bytes.
  //
  // Today the gate forces loopback so both run on the same machine; once
  // Shape A ships and a hosted node is allowed, chat-server's storage and
  // identity stay on the user's device while the node's storage moves to
  // the operator's host.
  let chatServer = null;
  let ownerAccountId = "";
  if (nodeApp) {
    // Pin the chat-server's SDK to this in-process node's identity pubkey.
    // The SDK refuses to authenticate against any node whose challenge
    // claims a different pubkey, defeating cross-node session-auth
    // forwarding (docs/SECURITY_AUDIT.md CRITICAL-2).
    const nodeIdentity = nodeApp.runtime && typeof nodeApp.runtime.getIdentity === "function"
      ? nodeApp.runtime.getIdentity()
      : null;
    const expectedNodePublicKeyB64 = nodeIdentity && typeof nodeIdentity.nodePublicKeyB64 === "string"
      ? nodeIdentity.nodePublicKeyB64.trim()
      : "";
    if (!expectedNodePublicKeyB64) {
      throw new Error("rez-chat bootstrap: launched node missing nodePublicKeyB64 — cannot pin SDK to node identity");
    }
    const bootstrapped = await bootstrapChatServer({
      nodeDataDir: config.node.storage.dataDir,
      wsUrl,
      expectedNodePublicKeyB64,
    });
    chatServer = bootstrapped.chatServer;
    ownerAccountId = bootstrapped.ownerAccountId;
  }

  const bridgeToken = randomBytes(32).toString("base64url");

  const shellPort = options.shellPort ?? SHELL_PORT;
  const shellHost = options.shellHost ?? SHELL_HOST;
  const shell = await new ChatShellHost({
    uiRoot,
    wsUrl,
    port: shellPort,
    host: shellHost,
    skipUiRootCheck,
    e2eDebug: String(process.env.REZ_E2E_DEBUG || "").trim() === "1",
    chatServer,
    bridgeToken,
  }).start();

  // Start chatServer in background — shell is already serving, browser can load
  if (chatServer) {
    chatServer.start()
      .then(() => {
        shell.bridge.setReady(true);
        chatLog("log", "chatServer started, bridge ready");
      })
      .catch((err) => {
        const msg = err && err.message ? err.message : String(err);
        chatLog("error", "chatServer start failed:", msg);
      });
  }

  const shellAddr = shell.address || {};
  const resolvedShellHost =
    shellAddr.host && shellAddr.host !== "0.0.0.0"
      ? shellAddr.host
      : shellHost;
  const resolvedShellPort = Number.isInteger(shellAddr.port) && shellAddr.port > 0
    ? shellAddr.port
    : shellPort;
  chatLog("log", `${process.env.CHAT_ID || "rez-chat"} shell http://${resolvedShellHost}:${resolvedShellPort} ws ${wsUrl}`);

  return {
    config,
    configPath,
    configCreated: created,
    nodeApp,
    chatServer,
    shell,
    wsUrl,
    async stop() {
      if (chatServer) {
        await chatServer.stop().catch((err) => {
          chatLog("warn", "chatServer stop failed:", err && err.message ? err.message : err);
        });
      }
      await shell.stop();
      if (nodeApp && typeof nodeApp.stop === "function") {
        await nodeApp.stop();
      }
    },
  };
}

export async function start() {
  return startRezChat();
}

function buildWsUrl(config) {
  const nodeConfig = config && typeof config === "object" ? config.node : null;
  const ws = nodeConfig && typeof nodeConfig === "object" ? nodeConfig.ws : null;
  if (!ws || typeof ws !== "object") throw new Error("Missing config.node.ws");
  if (!Number.isInteger(ws.port)) throw new Error("Invalid config.node.ws.port");
  if (typeof ws.path !== "string") throw new Error("Invalid config.node.ws.path");
  const wsHost = coerceWsHost(ws.host);
  if (process.env.CHAT_WS_URL) {
    return process.env.CHAT_WS_URL;
  }
  if (process.env.HOST_NODE_WS_PORT) {
    const hostPort = parseInt(process.env.HOST_NODE_WS_PORT, 10);
    if (!Number.isInteger(hostPort)) throw new Error("Invalid HOST_NODE_WS_PORT");
    return `ws://${wsHost}:${hostPort}${ws.path}`;
  }
  return `ws://${wsHost}:${ws.port}${ws.path}`;
}

function coerceWsHost(hostRaw) {
  const host = String(hostRaw || "").trim();
  if (!host) return "127.0.0.1";
  if (host === "0.0.0.0" || host === "::" || host === "::0") return "127.0.0.1";
  return host;
}

function resolveUiRoot(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  return path.isAbsolute(raw) ? raw : path.resolve(CHAT_ROOT, raw);
}

function resolveConfiguredDataDir({ dataDir, configPath }) {
  const configDir = path.dirname(path.resolve(configPath));
  const fallback = path.resolve(configDir, DEFAULT_NODE_DATA_DIR);

  const raw = typeof dataDir === "string" ? dataDir.trim() : "";
  if (!raw) return fallback;
  if (!path.isAbsolute(raw)) return path.resolve(configDir, raw);

  const portableTail = path.normalize(path.join("rez-chat", ".local", "rez-node-data"));
  const normalizedRaw = path.normalize(raw);
  const currentPortable = path.normalize(path.resolve(configDir, DEFAULT_NODE_DATA_DIR));
  if (normalizedRaw.endsWith(portableTail) && normalizedRaw !== currentPortable) {
    return path.resolve(configDir, DEFAULT_NODE_DATA_DIR);
  }

  return raw;
}

function coerceDefaultThreadId(value) {
  const threadId = String(value || "").trim();
  if (/^th_[A-Za-z0-9_-]{22}$/.test(threadId)) return threadId;
  if (threadId) {
    chatLog("warn", `clearing invalid node.storage.defaultThreadId "${threadId}"`);
  }
  return null;
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  chatLog("log", "starting...");
  startRezChat()
    .then((app) => {
      const shellAddr = app.shell.address;
      chatLog("log", `config: ${app.configPath}${app.configCreated ? " (created)" : ""}`);
      chatLog("log", `rez-node ws: ${app.wsUrl}`);
      chatLog("log", `shell: http://${shellAddr.host}:${shellAddr.port}/`);

      const shutdown = async () => {
        await app.stop();
        process.exit(0);
      };

      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
