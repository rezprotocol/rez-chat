import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { prepareElectronNativeModules, restoreNodeNativeModules } from "./desktop-native-modules.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHAT_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(CHAT_ROOT, "..");
const DEFAULT_PROFILE_ROOT = path.join(CHAT_ROOT, ".local", "desktop-profiles");

const PROFILE_DEFAULTS = Object.freeze({
  alice: Object.freeze({
    desktopPort: 3410,
    nodeWsPort: 8787,
    windowX: 24,
    windowY: 48,
    windowWidth: 680,
    windowHeight: 820,
  }),
  bob: Object.freeze({
    desktopPort: 3420,
    nodeWsPort: 8788,
    windowX: 736,
    windowY: 48,
    windowWidth: 680,
    windowHeight: 820,
  }),
});

export function listDesktopProfiles() {
  return Object.keys(PROFILE_DEFAULTS);
}

export function resolveDesktopProfile(profileName, env = process.env) {
  const name = String(profileName || "alice").trim().toLowerCase();
  const defaults = PROFILE_DEFAULTS[name];
  if (!defaults) {
    throw new Error("Unknown desktop profile: " + name + " (expected " + listDesktopProfiles().join("|") + ")");
  }

  const upperName = name.toUpperCase();
  const profileRoot = resolvePath(env.REZ_CHAT_DESKTOP_PROFILE_ROOT || DEFAULT_PROFILE_ROOT);
  const userDataDir = resolvePath(
    env["REZ_CHAT_" + upperName + "_USER_DATA_DIR"]
    || env.REZ_CHAT_USER_DATA_DIR
    || path.join(profileRoot, name),
  );
  const desktopPort = parsePort(
    env["REZ_CHAT_" + upperName + "_DESKTOP_PORT"] || env.REZ_CHAT_DESKTOP_PORT,
    defaults.desktopPort,
    "desktop port",
  );
  const nodeWsPort = parsePort(
    env["REZ_CHAT_" + upperName + "_NODE_WS_PORT"] || env.REZ_NODE_WS_PORT,
    defaults.nodeWsPort,
    "node websocket port",
  );
  const windowX = parseOptionalInteger(
    env["REZ_CHAT_" + upperName + "_WINDOW_X"] || env.REZ_CHAT_WINDOW_X,
    defaults.windowX,
    "window x",
  );
  const windowY = parseOptionalInteger(
    env["REZ_CHAT_" + upperName + "_WINDOW_Y"] || env.REZ_CHAT_WINDOW_Y,
    defaults.windowY,
    "window y",
  );
  const windowWidth = parseWindowSize(
    env["REZ_CHAT_" + upperName + "_WINDOW_WIDTH"] || env.REZ_CHAT_WINDOW_WIDTH,
    defaults.windowWidth,
    "window width",
  );
  const windowHeight = parseWindowSize(
    env["REZ_CHAT_" + upperName + "_WINDOW_HEIGHT"] || env.REZ_CHAT_WINDOW_HEIGHT,
    defaults.windowHeight,
    "window height",
  );

  return {
    name,
    userDataDir,
    desktopPort,
    nodeWsPort,
    windowX,
    windowY,
    windowWidth,
    windowHeight,
  };
}

export function launchDesktopProfile(profileName, options = {}) {
  const profile = resolveDesktopProfile(profileName, options.env || process.env);
  fs.mkdirSync(profile.userDataDir, { recursive: true });

  const child = spawn(electronCommand(), ["./electron/main.mjs"], {
    cwd: CHAT_ROOT,
    env: {
      ...process.env,
      REZ_CHAT_PROFILE: profile.name,
      REZ_CHAT_USER_DATA_DIR: profile.userDataDir,
      REZ_CHAT_DESKTOP_PORT: String(profile.desktopPort),
      REZ_NODE_WS_PORT: String(profile.nodeWsPort),
      REZ_CHAT_WINDOW_X: String(profile.windowX),
      REZ_CHAT_WINDOW_Y: String(profile.windowY),
      REZ_CHAT_WINDOW_WIDTH: String(profile.windowWidth),
      REZ_CHAT_WINDOW_HEIGHT: String(profile.windowHeight),
      CHAT_ID: "desktop-" + profile.name,
      // Default the receive-path / peer-link trace ON for two-node dev runs so a
      // captured run.log shows exactly where a deposit is classified, decrypted,
      // or dropped. Overridable from the parent env.
      REZ_PEERLINK_TRACE: process.env.REZ_PEERLINK_TRACE || "1",
      REZ_INBOX_CATCHUP_DEBUG: process.env.REZ_INBOX_CATCHUP_DEBUG || "1",
      REZ_ROUTE_DEBUG: process.env.REZ_ROUTE_DEBUG || "1",
    },
    stdio: options.prefix ? ["inherit", "pipe", "pipe"] : "inherit",
  });

  // Tee everything the child emits (main process + embedded node + chat-server)
  // to <userDataDir>/run.log so the full live log is readable from disk, not just
  // the terminal. Truncated on each launch. Renderer/UI console stays in devtools.
  let logStream = null;
  if (options.prefix) {
    const logPath = path.join(profile.userDataDir, "run.log");
    logStream = fs.createWriteStream(logPath, { flags: "w" });
    logStream.write("=== run.log " + profile.name + " started " + new Date().toISOString() + " ===\n");
    prefixStream(child.stdout, "[" + profile.name + "] ", process.stdout, logStream);
    prefixStream(child.stderr, "[" + profile.name + "] ", process.stderr, logStream);
  }

  child.once("exit", (code, signal) => {
    if (logStream) {
      logStream.end("=== run.log " + profile.name + " exited code=" + String(code) + " signal=" + String(signal || "") + " ===\n");
    }
    if (options.onExit) {
      options.onExit({ profile, code, signal });
    }
  });

  return { profile, child };
}

function electronCommand() {
  const binName = process.platform === "win32" ? "electron.cmd" : "electron";
  const localBin = path.join(CHAT_ROOT, "node_modules", ".bin", binName);
  if (fs.existsSync(localBin)) return localBin;
  return binName;
}

function resolvePath(value) {
  const raw = String(value || "").trim();
  if (!raw) throw new Error("Path value required");
  return path.isAbsolute(raw) ? raw : path.resolve(REPO_ROOT, raw);
}

function parsePort(value, fallback, label) {
  const raw = String(value || "").trim();
  const port = raw ? Number.parseInt(raw, 10) : fallback;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error("Invalid " + label + ": " + (raw || String(fallback)));
  }
  return port;
}

function parseOptionalInteger(value, fallback, label) {
  const raw = String(value || "").trim();
  const result = raw ? Number.parseInt(raw, 10) : fallback;
  if (!Number.isInteger(result)) {
    throw new Error("Invalid " + label + ": " + (raw || String(fallback)));
  }
  return result;
}

function parseWindowSize(value, fallback, label) {
  const raw = String(value || "").trim();
  const result = raw ? Number.parseInt(raw, 10) : fallback;
  if (!Number.isInteger(result) || result < 480 || result > 10000) {
    throw new Error("Invalid " + label + ": " + (raw || String(fallback)));
  }
  return result;
}

function prefixStream(stream, prefix, target, fileStream) {
  if (!stream) return;
  stream.on("data", (chunk) => {
    const text = String(chunk || "");
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (!line && i === lines.length - 1) continue;
      target.write(prefix + line + "\n");
      if (fileStream) fileStream.write(new Date().toISOString() + " " + line + "\n");
    }
  });
}

function printHelp() {
  console.log(`Usage: node scripts/desktop-dev-profile.mjs <alice|bob>

Environment overrides:
  REZ_CHAT_DESKTOP_PROFILE_ROOT       Base dir for profiles (default: rez-chat/.local/desktop-profiles)
  REZ_CHAT_USER_DATA_DIR              User-data dir for one manually launched profile
  REZ_CHAT_ALICE_USER_DATA_DIR        Alice user-data dir
  REZ_CHAT_BOB_USER_DATA_DIR          Bob user-data dir
  REZ_CHAT_ALICE_DESKTOP_PORT         Alice shell port (default: 3410)
  REZ_CHAT_BOB_DESKTOP_PORT           Bob shell port (default: 3420)
  REZ_CHAT_ALICE_NODE_WS_PORT         Alice embedded node WS port (default: 8787)
  REZ_CHAT_BOB_NODE_WS_PORT           Bob embedded node WS port (default: 8788)
  REZ_CHAT_WINDOW_X/Y                 Window position for one manually launched profile
  REZ_CHAT_WINDOW_WIDTH/HEIGHT        Window size for one manually launched profile
  REZ_CHAT_ALICE_WINDOW_X/Y           Alice window position (default: 24,48)
  REZ_CHAT_BOB_WINDOW_X/Y             Bob window position (default: 736,48)
`);
}

async function main() {
  const arg = String(process.argv[2] || "alice").trim();
  if (arg === "--help" || arg === "-h") {
    printHelp();
    return;
  }

  await prepareElectronNativeModules();
  // prefix:true so a single-profile launch also tees its full log to
  // <userDataDir>/run.log — needed to capture an offline-accept run where alice
  // and bob are launched in separate terminals (so one can be quit independently).
  const { profile, child } = launchDesktopProfile(arg, { prefix: true });
  console.log("[desktop:" + profile.name + "] userData " + profile.userDataDir);
  console.log("[desktop:" + profile.name + "] run.log " + path.join(profile.userDataDir, "run.log"));
  console.log("[desktop:" + profile.name + "] shell http://127.0.0.1:" + profile.desktopPort + "/");
  console.log("[desktop:" + profile.name + "] node ws://127.0.0.1:" + profile.nodeWsPort + "/ws");
  console.log("[desktop:" + profile.name + "] window " + profile.windowWidth + "x" + profile.windowHeight + "+" + profile.windowX + "+" + profile.windowY);

  let exiting = false;
  const finish = async (code, signal) => {
    if (exiting) return;
    exiting = true;
    try {
      await restoreNodeNativeModules();
    } catch (err) {
      console.error("[desktop:native] restore failed:", err && err.message ? err.message : err);
      if (code == null || code === 0) code = 1;
    }
    if (signal) {
      process.exit(signalExitCode(signal));
      return;
    }
    process.exit(code == null ? 0 : code);
  };

  process.on("SIGINT", () => {
    if (!child.killed) child.kill("SIGINT");
  });
  process.on("SIGTERM", () => {
    if (!child.killed) child.kill("SIGTERM");
  });

  child.once("exit", (code, signal) => {
    finish(code, signal);
  });
}

function signalExitCode(signal) {
  if (signal === "SIGINT") return 130;
  if (signal === "SIGTERM") return 143;
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error("[desktop] failed:", err && err.message ? err.message : err);
    process.exit(1);
  });
}
