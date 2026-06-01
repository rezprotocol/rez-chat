import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { scrypt } from "node:crypto";
import { promisify } from "node:util";
import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell, screen, systemPreferences } from "electron";
import { NodeCryptoProvider } from "@rezprotocol/node";
import { startRezChat } from "../src/index.js";
import { DesktopVaultService } from "./runtime/DesktopVaultService.mjs";
import { DesktopSupervisor, defaultDesktopPaths } from "./runtime/DesktopSupervisor.mjs";
import { registerDesktopRuntimeIpc } from "./runtime/registerDesktopIpc.mjs";
import { BiometricGate } from "./runtime/BiometricGate.mjs";
import { DesktopTray } from "./runtime/DesktopTray.mjs";
import { DesktopUpdater } from "./runtime/DesktopUpdater.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Standalone rez-chat repo: electron/ lives at the package root. CHAT_ROOT
// is the rez-chat directory in dev; in the packaged Electron app it's the
// asar root (Contents/Resources/app.asar/) where rez-chat's files were
// bundled to.
const CHAT_ROOT = path.resolve(__dirname, "..");
// vite outputs to <rez-chat>/artifacts/rez-chat in dev; electron-builder
// bundles that directory into the asar at the same relative path, so
// CHAT_ROOT/artifacts/rez-chat resolves correctly in both modes.
const DEFAULT_UI_ROOT = path.join(CHAT_ROOT, "artifacts", "rez-chat");
const DEFAULT_DESKTOP_SHELL_PORT = 3410;

const scryptAsync = promisify(scrypt);

let chatApp = null;
let mainWindow = null;
let trustedOrigin = null;
let stopping = null;
let desktopSupervisor = null;
let desktopTray = null;
let desktopUpdater = null;
const desktopCrypto = new NodeCryptoProvider();

// Tray icon: in dev, pull from the sibling rez-ui repo's branding directory
// (the on-disk folder is still named rez-ui). In the packaged app the icon
// ships under node_modules/@rezprotocol/ui/branding/ (the electron-builder.yml
// filter includes branding/** for @rezprotocol/ui).
const TRAY_ICON_PATH = app.isPackaged
  ? path.join(app.getAppPath(), "node_modules", "@rezprotocol", "ui", "branding", "filled-silhouette", "rez-icon-mark-transparent-filled.png")
  : path.resolve(CHAT_ROOT, "..", "rez-ui", "branding", "filled-silhouette", "rez-icon-mark-transparent-filled.png");
// Cap how far we look for unread when summing — must be >= ChatThreadIndex MAX_INDEX_SIZE.
const UNREAD_SUM_LIMIT = 500;

async function recomputeUnreadAndUpdateTray(app) {
  if (!desktopTray) return;
  if (!app || !app.threadIndex || typeof app.threadIndex.listThreadIndex !== "function") {
    desktopTray.setUnreadCount(0);
    return;
  }
  try {
    const result = await app.threadIndex.listThreadIndex({ limit: UNREAD_SUM_LIMIT });
    const threads = result && Array.isArray(result.threads) ? result.threads : [];
    let total = 0;
    for (const entry of threads) {
      const n = entry && Number.isFinite(entry.unreadCount) ? entry.unreadCount : 0;
      if (n > 0) total += n;
    }
    desktopTray.setUnreadCount(total);
  } catch (err) {
    console.warn("[rez-chat:desktop] tray unread recompute failed", err && err.message ? err.message : err);
  }
}

function bindTrayToChatApp(app) {
  if (!desktopTray) return () => {};
  if (!app || typeof app.on !== "function") {
    desktopTray.setUnreadCount(0);
    return () => {};
  }
  recomputeUnreadAndUpdateTray(app);
  const off = app.on("thread.index.updated", () => {
    recomputeUnreadAndUpdateTray(app);
  });
  return typeof off === "function" ? off : () => {};
}

function resolveUserDataOverride() {
  const envValue = String(process.env.REZ_CHAT_USER_DATA_DIR || "").trim();
  if (envValue) {
    return path.isAbsolute(envValue) ? envValue : path.resolve(CHAT_ROOT, envValue);
  }
  const prefix = "--rez-user-data-dir=";
  const arg = process.argv.find((item) => typeof item === "string" && item.startsWith(prefix));
  if (!arg) return null;
  const value = String(arg.slice(prefix.length) || "").trim();
  if (!value) return null;
  return path.isAbsolute(value) ? value : path.resolve(CHAT_ROOT, value);
}

function applyUserDataOverride() {
  const userDataDir = resolveUserDataOverride();
  if (!userDataDir) return;
  fs.mkdirSync(userDataDir, { recursive: true });
  app.setPath("userData", userDataDir);
}

function isDesktopDev() {
  return !app.isPackaged;
}

function resolveUiRoot() {
  const raw = String(process.env.CHAT_UI_ROOT || "").trim();
  if (!raw) return DEFAULT_UI_ROOT;
  return path.isAbsolute(raw) ? raw : path.resolve(CHAT_ROOT, raw);
}

function resolveDesktopShellPort() {
  const raw = String(process.env.REZ_CHAT_DESKTOP_PORT || "").trim();
  if (!raw) return DEFAULT_DESKTOP_SHELL_PORT;
  const port = Number.parseInt(raw, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid REZ_CHAT_DESKTOP_PORT: ${raw}`);
  }
  return port;
}

function resolveWindowBounds() {
  const bounds = {
    width: resolveWindowSize("REZ_CHAT_WINDOW_WIDTH", 1280),
    height: resolveWindowSize("REZ_CHAT_WINDOW_HEIGHT", 860),
  };
  const x = resolveWindowPosition("REZ_CHAT_WINDOW_X");
  const y = resolveWindowPosition("REZ_CHAT_WINDOW_Y");
  if (Number.isInteger(x)) bounds.x = x;
  if (Number.isInteger(y)) bounds.y = y;
  return clampWindowBounds(bounds);
}

function resolveWindowSize(envKey, fallback) {
  const raw = String(process.env[envKey] || "").trim();
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 480 || value > 10000) {
    throw new Error(`Invalid ${envKey}: ${raw}`);
  }
  return value;
}

function resolveWindowPosition(envKey) {
  const raw = String(process.env[envKey] || "").trim();
  if (!raw) return null;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value)) {
    throw new Error(`Invalid ${envKey}: ${raw}`);
  }
  return value;
}

function clampWindowBounds(bounds) {
  const display = screen.getDisplayMatching({
    x: Number.isInteger(bounds.x) ? bounds.x : 0,
    y: Number.isInteger(bounds.y) ? bounds.y : 0,
    width: bounds.width,
    height: bounds.height,
  });
  const workArea = display && display.workArea ? display.workArea : screen.getPrimaryDisplay().workArea;
  const width = Math.min(bounds.width, workArea.width);
  const height = Math.min(bounds.height, workArea.height);
  const result = {
    width,
    height,
  };
  if (Number.isInteger(bounds.x)) {
    result.x = clamp(bounds.x, workArea.x, workArea.x + workArea.width - width);
  }
  if (Number.isInteger(bounds.y)) {
    result.y = clamp(bounds.y, workArea.y, workArea.y + workArea.height - height);
  }
  return result;
}

function clamp(value, min, max) {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

function isTrustedUrl(urlRaw) {
  if (!trustedOrigin) return false;
  try {
    const next = new URL(urlRaw);
    return next.origin === trustedOrigin;
  } catch {
    return false;
  }
}

function isExternalHttpUrl(urlRaw) {
  try {
    const next = new URL(urlRaw);
    return next.protocol === "http:" || next.protocol === "https:";
  } catch {
    return false;
  }
}

async function stopChatApp() {
  if (stopping) return stopping;
  stopping = (async () => {
    const supervisor = desktopSupervisor;
    desktopSupervisor = null;
    if (supervisor) {
      await supervisor.stop();
      chatApp = null;
      return;
    }
    const current = chatApp;
    chatApp = null;
    if (current && typeof current.stop === "function") {
      await current.stop();
    }
  })().finally(() => {
    stopping = null;
  });
  return stopping;
}

function registerDesktopIpc() {
  ipcMain.handle("desktop:getAppInfo", () => ({
    appVersion: app.getVersion(),
    platform: process.platform,
  }));

  ipcMain.handle("desktop:openExternal", async (_event, urlRaw) => {
    const value = String(urlRaw || "").trim();
    if (!isExternalHttpUrl(value)) return false;
    await shell.openExternal(value);
    return true;
  });

  ipcMain.handle("desktop:generateSigningKeyPair", () => {
    const { publicKey, privateKey } = desktopCrypto.generateSigningKeyPair();
    return { publicKey, privateKey };
  });

  ipcMain.handle("desktop:sign", (_event, options = {}) => desktopCrypto.sign(options));
  ipcMain.handle("desktop:verify", (_event, options = {}) => desktopCrypto.verify(options));
  ipcMain.handle("desktop:dhGenerateKeyPair", (_event, options = {}) => desktopCrypto.dhGenerateKeyPair(options));
  ipcMain.handle("desktop:dhDerive", (_event, options = {}) => desktopCrypto.dhDerive(options));

  ipcMain.handle("desktop:updates:getStatus", () => {
    if (!desktopUpdater) return { state: "idle" };
    return desktopUpdater.getStatus();
  });
  ipcMain.handle("desktop:updates:restartAndInstall", () => {
    if (!desktopUpdater) return false;
    desktopUpdater.quitAndInstall();
    return true;
  });

  /**
   * Native scrypt key derivation — memory-hard, GPU/ASIC resistant.
   * Only available in Electron; the browser renderer calls this via IPC.
   *
   * Parameters match Node.js crypto.scrypt options:
   *   password {string}, salt {Uint8Array}, N {number}, r {number}, p {number}, keyLen {number}
   *
   * maxmem is computed as 2× the theoretical requirement (128 * N * r) to leave headroom.
   * At N=2^17, r=8: requirement = 128 MiB → maxmem = 256 MiB.
   */
  ipcMain.handle("desktop:scrypt", async (_event, opts = {}) => {
    const password = String(opts.password || "");
    if (!password) throw new Error("desktop:scrypt: password required");

    // Structured clone transfers Uint8Array correctly through IPC.
    const salt = opts.salt instanceof Uint8Array ? opts.salt : Buffer.from(Object.values(opts.salt || {}));
    if (!salt || salt.length < 16) throw new Error("desktop:scrypt: salt must be >= 16 bytes");

    const N = Number(opts.N);
    const r = Number(opts.r);
    const p = Number(opts.p);
    const keyLen = Number(opts.keyLen);

    if (!Number.isInteger(N) || N < 1024 || N > 1_048_576 || (N & (N - 1)) !== 0) {
      throw new Error(`desktop:scrypt: invalid N (${N}), must be power-of-two >= 1024 and <= 2^20`);
    }
    if (!Number.isInteger(r) || r < 1) throw new Error(`desktop:scrypt: invalid r (${r})`);
    if (!Number.isInteger(p) || p < 1) throw new Error(`desktop:scrypt: invalid p (${p})`);
    if (!Number.isInteger(keyLen) || keyLen < 16 || keyLen > 64) {
      throw new Error(`desktop:scrypt: invalid keyLen (${keyLen})`);
    }

    // 2× headroom over the 128 * N * r byte requirement; minimum 256 MiB at N=2^17, r=8.
    const maxmem = 2 * 128 * N * r;

    const keyBuffer = await scryptAsync(password, Buffer.from(salt), keyLen, { N, r, p, maxmem });
    return new Uint8Array(keyBuffer);
  });

  /**
   * Encrypted-backup file I/O. The vault produces/consumes the ciphertext
   * envelope (pure crypto, no fs); these two channels are the ONLY place that
   * touches the disk + native file dialogs. Kept in main.mjs (not
   * registerDesktopIpc.mjs) so the transport-generality allowlist there stays
   * vault/runtime-only. The envelope is already encrypted under the seed KEK,
   * so the plaintext bundle never crosses this boundary.
   */
  ipcMain.handle("desktop:backup:saveToFile", async (_event, args = {}) => {
    try {
      const envelope = args && args.envelope != null ? args.envelope : null;
      if (!envelope || typeof envelope !== "object") {
        throw new Error("desktop:backup:saveToFile requires an envelope object");
      }
      const suggestedName = String(args && args.suggestedName ? args.suggestedName : "rez-backup.json");
      const res = await dialog.showSaveDialog(mainWindow || null, {
        title: "Save Rez backup",
        defaultPath: suggestedName,
        filters: [{ name: "Rez Backup", extensions: ["json"] }],
      });
      if (res.canceled || !res.filePath) return { ok: true, result: { canceled: true } };
      fs.writeFileSync(res.filePath, JSON.stringify(envelope, null, 2), { encoding: "utf8" });
      return { ok: true, result: { canceled: false, filePath: res.filePath } };
    } catch (err) {
      return { ok: false, error: { message: err && err.message ? String(err.message) : "Could not save backup" } };
    }
  });

  ipcMain.handle("desktop:backup:openFile", async () => {
    try {
      const res = await dialog.showOpenDialog(mainWindow || null, {
        title: "Restore Rez backup",
        properties: ["openFile"],
        filters: [{ name: "Rez Backup", extensions: ["json"] }],
      });
      if (res.canceled || !res.filePaths || res.filePaths.length === 0) {
        return { ok: true, result: { canceled: true } };
      }
      const text = fs.readFileSync(res.filePaths[0], { encoding: "utf8" });
      let envelope = null;
      try {
        envelope = JSON.parse(text);
      } catch (parseErr) {
        throw new Error("Selected file is not a valid Rez backup (JSON parse failed)");
      }
      return { ok: true, result: { canceled: false, envelope } };
    } catch (err) {
      return { ok: false, error: { message: err && err.message ? String(err.message) : "Could not open backup" } };
    }
  });
}

function createMainWindow(shellUrl) {
  trustedOrigin = new URL(shellUrl).origin;
  const windowBounds = resolveWindowBounds();
  mainWindow = new BrowserWindow({
    width: windowBounds.width,
    height: windowBounds.height,
    x: windowBounds.x,
    y: windowBounds.y,
    minWidth: 760,
    minHeight: 600,
    resizable: true,
    show: false,
    autoHideMenuBar: true,
    title: "Rez Chat",
    titleBarStyle: "default",
    webPreferences: {
      preload: app.isPackaged
            ? path.resolve(__dirname, "preload.cjs").replace("app.asar", "app.asar.unpacked")
            : path.resolve(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (isDesktopDev()) {
    const levelLabels = ["log", "warn", "error"];
    mainWindow.webContents.on("console-message", (_event, level, message, line, sourceId) => {
      const label = levelLabels[level] || "log";
      const location = sourceId ? ` ${sourceId}:${line}` : "";
      console[label](`[rez-chat:renderer] ${message}${location}`);
    });
    mainWindow.webContents.on("did-finish-load", () => {
      if (mainWindow && mainWindow.webContents) {
        mainWindow.webContents.openDevTools({ mode: "detach", activate: false });
      }
    });
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isTrustedUrl(url)) return { action: "allow" };
    if (isExternalHttpUrl(url)) {
      shell.openExternal(url).catch(() => {});
    }
    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (isTrustedUrl(url)) return;
    event.preventDefault();
    if (isExternalHttpUrl(url)) {
      shell.openExternal(url).catch(() => {});
    }
  });

  mainWindow.once("ready-to-show", () => {
    if (mainWindow) mainWindow.show();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  mainWindow.loadURL(shellUrl);
}

async function startDesktop() {
  registerDesktopIpc();

  // Use Electron's userData directory for node data (not the asar).
  // The config file also lives here so relative dataDir resolves correctly.
  const userDataDir = app.getPath("userData");
  const desktopPaths = defaultDesktopPaths(userDataDir);
  const configPath = desktopPaths.nodeConfigPath;

  chatApp = await startRezChat({
    shellHost: "127.0.0.1",
    shellPort: resolveDesktopShellPort(),
    uiRoot: resolveUiRoot(),
    skipUiRootCheck: false,
    configPath,
  });

  const vault = new DesktopVaultService({
    dbPath: desktopPaths.vaultDbPath,
    safeStorage,
  }).open();
  desktopSupervisor = new DesktopSupervisor({
    vault,
    chatApp,
    logger: console,
  });
  await desktopSupervisor.start();
  const biometricGate = new BiometricGate({ systemPreferences });
  registerDesktopRuntimeIpc({
    ipcMain,
    supervisor: desktopSupervisor,
    biometricGate,
    getWindow: () => mainWindow,
    // SECURITY_AUDIT MED-10: native confirmation dialog before biometric.
    // The renderer cannot dismiss this dialog programmatically, so a
    // compromised renderer cannot silently chain into a biometric unlock.
    confirmUnlockWithDevice: async () => {
      try {
        const result = await dialog.showMessageBox(mainWindow || null, {
          type: "question",
          title: "Unlock Rez",
          message: "Unlock Rez with device biometric?",
          detail: "Rez is requesting to unlock your local account vault using "
            + "this device's biometric (Touch ID / Windows Hello).\n\n"
            + "If you did NOT just take an action that should require an unlock, "
            + "click Cancel.",
          buttons: ["Cancel", "Unlock"],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        });
        return result && result.response === 1;
      } catch (err) {
        console.error("[rez-chat:desktop] unlock confirm dialog failed",
          err && err.message ? err.message : err);
        return false;
      }
    },
  });

  try {
    desktopTray = new DesktopTray({
      iconPath: TRAY_ICON_PATH,
      getWindow: () => mainWindow,
    });
  } catch (err) {
    console.warn("[rez-chat:desktop] failed to create tray icon", err && err.message ? err.message : err);
    desktopTray = null;
  }
  let detachTrayBinding = () => {};
  desktopSupervisor.onChatAppChange((app) => {
    detachTrayBinding();
    detachTrayBinding = bindTrayToChatApp(app);
  });

  const address = chatApp && chatApp.shell ? chatApp.shell.address || {} : {};
  const host = address.host && address.host !== "0.0.0.0" ? address.host : "127.0.0.1";
  const port = address.port;
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error("Failed to resolve shell server port for desktop runtime");
  }
  createMainWindow(`http://${host}:${port}/`);

  desktopUpdater = new DesktopUpdater({
    app,
    logger: console,
    getWindow: () => mainWindow,
  });
  desktopUpdater.start();
}

app.on("before-quit", () => {
  if (desktopUpdater) {
    desktopUpdater.stop();
    desktopUpdater = null;
  }
  if (desktopTray) {
    desktopTray.destroy();
    desktopTray = null;
  }
  stopChatApp().catch(() => {});
});

app.on("window-all-closed", () => {
  app.quit();
});

applyUserDataOverride();

app.whenReady()
  .then(startDesktop)
  .catch(async (err) => {
    console.error("[rez-chat:desktop] failed to start", err);
    await stopChatApp().catch(() => {});
    app.exit(1);
  });
