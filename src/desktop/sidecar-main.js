import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { NodeCryptoProvider } from "@rezprotocol/node";
import { startRezChat } from "../index.js";
import { DesktopVaultService } from "./runtime/DesktopVaultService.js";
import { KeyringSafeStorage } from "./runtime/KeyringSafeStorage.js";
import { UserEnvironment } from "./runtime/UserEnvironment.js";
import { DesktopSupervisor, defaultDesktopPaths } from "./runtime/DesktopSupervisor.js";
import { registerDesktopRuntimeIpc } from "./runtime/registerDesktopIpc.js";
import { registerDesktopCryptoChannels } from "./runtime/registerDesktopCryptoChannels.js";
import { DesktopControlUplink } from "./transport/DesktopControlUplink.js";
import { HostChannel } from "./sidecar/HostChannel.js";
import { ParentWatchdog } from "./sidecar/ParentWatchdog.js";
import { InstanceLock } from "./sidecar/InstanceLock.js";

/**
 * Node sidecar entry point for the Tauri desktop shell.
 *
 * Hosts everything electron/main.mjs used to run in the Electron main
 * process — rez-node, the shell HTTP server, the vault, the supervisor —
 * as a child process of the Tauri (Rust) shell. The webview talks to it
 * over two token-gated loopback WebSockets on the shell server:
 *   /ws       chat bus (ChatWebsocketUplink, unchanged)
 *   /control  vault/runtime/crypto + generic bus:call (DesktopControlUplink)
 *
 * Spawn contract (the Rust shell provides):
 *   argv: --rez-sidecar               cmdline marker for InstanceLock
 *   env:  REZ_CHAT_USER_DATA_DIR      data directory (required)
 *         REZ_CONTROL_TOKEN           /control auth token (required)
 *         REZ_CHAT_DESKTOP_PORT       shell port (default 0 = ephemeral)
 *         REZ_ALLOWED_WS_ORIGIN       comma-separated extra WS origins
 *         REZ_CHAT_SKIP_UI_CHECK=1    skip uiRoot existence check (Tauri
 *                                     serves the UI via its asset protocol)
 *   stdio: stdin/stdout carry the HostChannel JSON-RPC (marker-prefixed
 *          lines); the host MUST keep our stdin pipe open for our lifetime.
 *
 * Zombie-prevention layers implemented here (plan layers 2 and 4):
 *   - stdin EOF (HostChannel.onParentGone)  primary parent-death detector
 *   - ppid polling (ParentWatchdog)          backstop detector
 *   - sidecar.lock (InstanceLock)            stale-instance cleanup at boot
 * Layer 1 (graceful {"op":"shutdown"}) and layer 3 (Windows Job Object)
 * live on the Rust side.
 */

const SHUTDOWN_GRACE_MS = 5000;
const PARENT_GONE_GRACE_MS = 3000;
// Cap how far we look for unread when summing — must be >= ChatThreadIndex
// MAX_INDEX_SIZE. Mirrors electron/main.mjs UNREAD_SUM_LIMIT.
const UNREAD_SUM_LIMIT = 500;
// Backstop poll cadence for the unread badge: thread.index.updated events
// are best-effort in this stack; a cheap periodic recompute guarantees the
// badge converges even when an event is missed (same rationale as the
// renderer's session-connect refetch).
const TRAY_UNREAD_POLL_MS = 10000;

function sidecarLog(method, ...args) {
  const writer = console && typeof console[method] === "function" ? console[method] : console.log;
  writer("[rez-sidecar]", ...args);
}

function requireEnv(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) {
    throw new Error("rez-sidecar requires env " + name);
  }
  return value;
}

function resolveShellPort() {
  const raw = String(process.env.REZ_CHAT_DESKTOP_PORT || "").trim();
  if (!raw) return 0;
  const port = Number.parseInt(raw, 10);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("Invalid REZ_CHAT_DESKTOP_PORT: " + raw);
  }
  return port;
}

function resolveAllowedOrigins() {
  const raw = String(process.env.REZ_ALLOWED_WS_ORIGIN || "").trim();
  if (!raw) return [];
  return raw.split(",").map((value) => value.trim()).filter((value) => value.length > 0);
}

function resolvePpidPollMs() {
  const raw = String(process.env.REZ_SIDECAR_PPID_POLL_MS || "").trim();
  if (!raw) return 5000;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 50) {
    throw new Error("Invalid REZ_SIDECAR_PPID_POLL_MS: " + raw);
  }
  return value;
}

/**
 * Unread-badge pump. Port of bindTrayToChatApp/recomputeUnreadAndUpdateTray
 * from electron/main.mjs: the sidecar owns the chat-server, computes the
 * unread total (event-driven + poll backstop), and pushes it to the Rust
 * shell over the HostChannel; Rust applies the dock/taskbar badge.
 */
function startUnreadBadgePump({ supervisor, hostChannel }) {
  const pushCount = (count) => {
    hostChannel.notify("badge.set", { count });
  };
  const recompute = async (chatApp) => {
    const server = chatApp && chatApp.chatServer ? chatApp.chatServer : null;
    if (!server || !server.threadIndex || typeof server.threadIndex.listThreadIndex !== "function") {
      pushCount(0);
      return;
    }
    try {
      const result = await server.threadIndex.listThreadIndex({ limit: UNREAD_SUM_LIMIT });
      const threads = result && Array.isArray(result.threads) ? result.threads : [];
      let total = 0;
      for (const entry of threads) {
        const n = entry && Number.isFinite(entry.unreadCount) ? entry.unreadCount : 0;
        if (n > 0) total += n;
      }
      pushCount(total);
    } catch (err) {
      sidecarLog("warn", "unread recompute failed:", err && err.message ? err.message : err);
    }
  };
  let detach = () => {};
  supervisor.onChatAppChange((chatApp) => {
    detach();
    const server = chatApp && chatApp.chatServer ? chatApp.chatServer : null;
    if (!server || typeof server.on !== "function") {
      pushCount(0);
      detach = () => {};
      return;
    }
    recompute(chatApp);
    const off = server.on("thread.index.updated", () => {
      recompute(chatApp);
    });
    const pollTimer = setInterval(() => recompute(chatApp), TRAY_UNREAD_POLL_MS);
    if (pollTimer && typeof pollTimer.unref === "function") pollTimer.unref();
    detach = () => {
      if (typeof off === "function") off();
      clearInterval(pollTimer);
    };
  });
}

export async function startSidecar() {
  if (!process.argv.includes(InstanceLock.CMDLINE_MARKER)) {
    // The marker is how InstanceLock verifies a lock-holder is really a
    // sidecar before killing it. A sidecar spawned without it can never be
    // reaped by lock cleanup — refuse to run half-protected.
    throw new Error("rez-sidecar must be spawned with the " + InstanceLock.CMDLINE_MARKER + " argv marker");
  }

  // Once the host dies, BOTH stdio pipes are gone: stderr writes (console
  // logging during teardown) would otherwise raise unhandled 'error' events
  // and crash the graceful shutdown. There is nowhere left to report to —
  // suppressing is the handling. (stdout is covered by HostChannel.)
  process.stderr.on("error", () => {});

  const userDataDir = path.resolve(requireEnv("REZ_CHAT_USER_DATA_DIR"));
  const controlToken = requireEnv("REZ_CONTROL_TOKEN");
  const allowedOrigins = resolveAllowedOrigins();
  const shellPort = resolveShellPort();
  const skipUiRootCheck = String(process.env.REZ_CHAT_SKIP_UI_CHECK || "").trim() === "1";
  fs.mkdirSync(userDataDir, { recursive: true });

  const instanceId = randomUUID();
  const desktopPaths = defaultDesktopPaths(userDataDir);
  const lock = new InstanceLock({
    lockPath: path.join(userDataDir, "sidecar.lock"),
    instanceId,
    logger: console,
  });

  let shuttingDown = false;
  let supervisor = null;
  let controlUplink = null;
  let hostChannel = null;
  let watchdog = null;

  const shutdown = (reason, graceMs) => {
    if (shuttingDown) return;
    shuttingDown = true;
    sidecarLog("log", "shutting down (" + reason + ")");
    // Hard deadline: if graceful teardown wedges (a hung relay socket, a
    // stuck sqlite handle), the sidecar must still die — a zombie backend
    // is worse than an unclean exit. unref'd so it can't keep us alive.
    const deadline = setTimeout(() => {
      sidecarLog("error", "graceful shutdown exceeded " + graceMs + "ms — forcing exit");
      lock.release();
      process.exit(1);
    }, graceMs);
    if (deadline && typeof deadline.unref === "function") deadline.unref();

    (async () => {
      if (watchdog) watchdog.stop();
      if (controlUplink) {
        try {
          await controlUplink.close();
        } catch (err) {
          sidecarLog("warn", "control uplink close failed:", err && err.message ? err.message : err);
        }
      }
      if (supervisor) {
        try {
          await supervisor.stop();
        } catch (err) {
          sidecarLog("warn", "supervisor stop failed:", err && err.message ? err.message : err);
        }
      }
      if (hostChannel) hostChannel.stop();
      lock.release();
      clearTimeout(deadline);
      process.exit(0);
    })().catch((err) => {
      sidecarLog("error", "shutdown failed:", err && err.message ? err.message : err);
      lock.release();
      process.exit(1);
    });
  };

  // Parent-death detection comes up FIRST so a host that dies while we are
  // still booting cannot orphan us.
  hostChannel = new HostChannel({
    onParentGone: (reason) => shutdown("parent gone: " + reason, PARENT_GONE_GRACE_MS),
    onRequest: async (op) => {
      if (op === "shutdown") {
        shutdown("host requested shutdown", SHUTDOWN_GRACE_MS);
        return { stopping: true };
      }
      if (op === "ping") {
        return { pong: true, instanceId };
      }
      const err = new Error("Unknown host op '" + op + "'");
      err.code = "UNKNOWN_HOST_OP";
      throw err;
    },
    logger: console,
  }).start();
  watchdog = new ParentWatchdog({
    pollMs: resolvePpidPollMs(),
    onParentGone: (reason) => shutdown("parent gone: " + reason, PARENT_GONE_GRACE_MS),
    logger: console,
  }).start();
  process.on("SIGTERM", () => shutdown("SIGTERM", SHUTDOWN_GRACE_MS));
  process.on("SIGINT", () => shutdown("SIGINT", SHUTDOWN_GRACE_MS));

  await lock.cleanupStale();

  const chatApp = await startRezChat({
    shellHost: "127.0.0.1",
    shellPort,
    skipUiRootCheck,
    configPath: desktopPaths.nodeConfigPath,
    allowedOrigins,
    reservedUpgradePaths: ["/control"],
    healthInfo: () => ({ sidecar: true, instanceId, pid: process.pid }),
  });

  // Probe machine capabilities ONCE at boot (os/arch, keychain, biometric).
  // This is the single source of truth the vault adapter and the UI both read
  // from. The keychain probe does NOT touch the device key, so no OS prompt
  // appears here — that's deferred to first device-unlock opt-in.
  const userEnvironment = new UserEnvironment({ hostChannel, logger: console });
  const capabilities = await userEnvironment.probe();

  // Device-unlock key storage: Rust keychain bridge over the HostChannel.
  // Availability comes from the probe above; the 32-byte key is fetched lazily
  // (KeyringSafeStorage.ensureDeviceKey) only when the user enables device
  // unlock. When the keychain is unavailable — tests, headless runs, a Linux
  // box with no Secret Service — this degrades to password-unlock-only, same
  // as Electron without safeStorage support.
  const safeStorage = await KeyringSafeStorage.create({
    hostChannel,
    available: capabilities.keychainAvailable,
  });
  const vault = new DesktopVaultService({
    dbPath: desktopPaths.vaultDbPath,
    safeStorage,
  }).open();
  supervisor = new DesktopSupervisor({
    vault,
    chatApp,
    userEnvironment,
    logger: console,
  });
  await supervisor.start();

  controlUplink = new DesktopControlUplink({
    server: chatApp.shell.server,
    controlToken,
    allowedOrigins,
    logger: console,
  });
  registerDesktopRuntimeIpc({
    ipcMain: controlUplink.ipcRegistry,
    supervisor,
    // SECURITY_AUDIT MED-10/MED-18: the Rust host shows the native confirm
    // dialog AND runs the biometric gesture as ONE atomic host op — the
    // webview cannot reach between them. biometricGate stays null because
    // the gesture lives inside confirmUnlock on the host side.
    biometricGate: null,
    getWindow: () => controlUplink.windowAdapter,
    confirmUnlockWithDevice: async () => {
      const result = await hostChannel.request(
        "biometric.confirmUnlock",
        { reason: "Unlock Rez" },
        { timeoutMs: 180000 },
      );
      return result && result.confirmed === true;
    },
  });
  registerDesktopCryptoChannels({
    ipcMain: controlUplink.ipcRegistry,
    crypto: new NodeCryptoProvider(),
  });
  controlUplink.start();

  startUnreadBadgePump({ supervisor, hostChannel });

  const address = chatApp.shell.address || {};
  const boundPort = Number.isInteger(address.port) && address.port > 0 ? address.port : shellPort;
  lock.write({ port: boundPort });
  hostChannel.notify("ready", { port: boundPort, pid: process.pid, instanceId });
  sidecarLog("log", "ready on 127.0.0.1:" + boundPort + " (instance " + instanceId + ")");

  return { chatApp, supervisor, controlUplink, instanceId, port: boundPort };
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  startSidecar().catch((err) => {
    sidecarLog("error", "failed to start:", err && err.stack ? err.stack : err);
    process.exit(1);
  });
}
