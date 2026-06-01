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
  // Capture the node's identity pubkey now so chat-server bootstrap later can
  // pin against it (defeating cross-node session-auth forwarding —
  // docs/SECURITY_AUDIT.md CRITICAL-2).
  let expectedNodePublicKeyB64 = "";
  if (nodeApp) {
    const nodeIdentity = nodeApp.runtime && typeof nodeApp.runtime.getIdentity === "function"
      ? nodeApp.runtime.getIdentity()
      : null;
    expectedNodePublicKeyB64 = nodeIdentity && typeof nodeIdentity.nodePublicKeyB64 === "string"
      ? nodeIdentity.nodePublicKeyB64.trim()
      : "";
    if (!expectedNodePublicKeyB64) {
      throw new Error("rez-chat bootstrap: launched node missing nodePublicKeyB64 — cannot pin SDK to node identity");
    }
  }

  const bridgeToken = randomBytes(32).toString("base64url");

  const shellPort = options.shellPort ?? SHELL_PORT;
  const shellHost = options.shellHost ?? SHELL_HOST;
  // Shell comes up with chatServer=null so the login UI can render before
  // vault unlock. Chat-server is bootstrapped lazily via startChatServer()
  // below, after the vault yields the BIP39-derived identity. The WS uplink
  // returns NOT_READY for any chat directive until then.
  const shell = await new ChatShellHost({
    uiRoot,
    wsUrl,
    port: shellPort,
    host: shellHost,
    skipUiRootCheck,
    e2eDebug: String(process.env.REZ_E2E_DEBUG || "").trim() === "1",
    chatServer: null,
    bridgeToken,
  }).start();

  const shellAddr = shell.address || {};
  const resolvedShellHost =
    shellAddr.host && shellAddr.host !== "0.0.0.0"
      ? shellAddr.host
      : shellHost;
  const resolvedShellPort = Number.isInteger(shellAddr.port) && shellAddr.port > 0
    ? shellAddr.port
    : shellPort;
  chatLog("log", `${process.env.CHAT_ID || "rez-chat"} shell http://${resolvedShellHost}:${resolvedShellPort} ws ${wsUrl}`);

  // chatServerState is mutated by start/stopChatServer; the chatServer getter
  // surfaces its current value to consumers (DesktopSupervisor, tests).
  // chatAppStopped guards the full stop() against double-teardown — the
  // supervisor calls stop() during its own stop(), but tests sometimes also
  // call chatApp.stop() directly afterwards.
  let chatServerState = null;
  let chatAppStopped = false;

  const chatApp = {
    config,
    configPath,
    configCreated: created,
    nodeApp,
    shell,
    wsUrl,
    get chatServer() {
      return chatServerState ? chatServerState.chatServer : null;
    },
    get ownerAccountId() {
      return chatServerState ? chatServerState.ownerAccountId : "";
    },

    /**
     * Bootstraps and starts chat-server using the BIP39-derived identity from
     * the vault. Idempotent: if chat-server is already running, returns the
     * existing state. The shell's WS uplink late-attaches and flips ready=true
     * once chat-server.start() resolves.
     *
     * `chatServerIdentity` MUST come from `DesktopVaultService.getChatServerIdentity()`
     * — that's the only source that derives it from the user's mnemonic.
     */
    async startChatServer({ chatServerIdentity = null, allowChatServerIdentityRotation = false } = {}) {
      if (chatServerState) return chatServerState;
      if (!chatServerIdentity || !chatServerIdentity.accountId || !chatServerIdentity.publicKeyB64 || !chatServerIdentity.privateKeyB64) {
        throw new Error("startChatServer requires chatServerIdentity with accountId/publicKeyB64/privateKeyB64");
      }
      const bootstrapped = await bootstrapChatServer({
        nodeDataDir: config.node.storage.dataDir,
        wsUrl,
        expectedNodePublicKeyB64,
        expectedChatServerIdentity: chatServerIdentity,
        allowChatServerIdentityRotation: allowChatServerIdentityRotation === true,
      });
      await bootstrapped.chatServer.start();
      shell.attachChatServer(bootstrapped.chatServer);
      chatServerState = bootstrapped;
      chatLog("log", "chatServer started, bridge ready (acct=" + bootstrapped.ownerAccountId + ")");
      return chatServerState;
    },

    /**
     * Stops chat-server but keeps node + shell up so a subsequent
     * startChatServer (e.g. re-login after logout) doesn't have to rebuild
     * everything. Idempotent.
     */
    async stopChatServer() {
      if (!chatServerState) return;
      const state = chatServerState;
      chatServerState = null;
      shell.detachChatServer();
      try {
        await state.chatServer.stop();
      } catch (err) {
        chatLog("warn", "chatServer stop failed:", err && err.message ? err.message : err);
      }
    },

    /**
     * Recursively delete the chat-server data dir (identity blob, ratchets,
     * messages, etc.). Caller MUST have already called stopChatServer().
     * Used by DesktopSupervisor.purgeAccount.
     */
    removeChatServerData() {
      const dir = path.join(config.node.storage.dataDir, "chat-server");
      fs.rmSync(dir, { recursive: true, force: true });
    },

    async stop() {
      if (chatAppStopped) return;
      chatAppStopped = true;
      await this.stopChatServer();
      await shell.stop();
      if (nodeApp && typeof nodeApp.stop === "function") {
        await nodeApp.stop();
      }
    },
  };

  return chatApp;
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
