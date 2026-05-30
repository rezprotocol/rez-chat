import electronUpdater from "electron-updater";

const { autoUpdater } = electronUpdater;

const CHECK_DELAY_MS = 30_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const STATUS_CHANNEL = "desktop:updates:status";

/**
 * DesktopUpdater
 *
 * Owns the electron-updater autoUpdater lifecycle for the desktop app.
 * Schedules a check 30s after start() and every 6h thereafter. Forwards
 * status events (checking, available, not-available, downloading, downloaded,
 * error) to the renderer via STATUS_CHANNEL. The renderer surfaces a banner
 * on "downloaded" and calls restartAndInstall() when the user clicks Restart.
 *
 * No-ops in dev (when app.isPackaged === false) — checks against GitHub
 * would otherwise hit the network with a missing publish config and confuse
 * developers.
 */
export class DesktopUpdater {
  #app;
  #logger;
  #getWindow;
  #started;
  #intervalHandle;
  #initialTimerHandle;
  #lastStatus;

  constructor({ app, logger, getWindow } = {}) {
    if (!app || typeof app.isPackaged !== "boolean") {
      throw new Error("DesktopUpdater requires the Electron app");
    }
    if (typeof getWindow !== "function") {
      throw new Error("DesktopUpdater requires getWindow()");
    }
    this.#app = app;
    this.#logger = logger && typeof logger.warn === "function" ? logger : console;
    this.#getWindow = getWindow;
    this.#started = false;
    this.#intervalHandle = null;
    this.#initialTimerHandle = null;
    this.#lastStatus = { state: "idle" };
  }

  start() {
    if (this.#started) return;
    if (!this.#app.isPackaged) {
      this.#logger.log("[rez-chat:updater] dev mode — auto-update disabled");
      return;
    }
    this.#started = true;
    autoUpdater.logger = this.#buildAutoUpdaterLogger();
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = false;
    this.#wireEvents();
    this.#initialTimerHandle = setTimeout(() => {
      this.#initialTimerHandle = null;
      this.#runCheck("initial");
    }, CHECK_DELAY_MS);
    this.#intervalHandle = setInterval(() => {
      this.#runCheck("interval");
    }, CHECK_INTERVAL_MS);
  }

  stop() {
    if (this.#initialTimerHandle) {
      clearTimeout(this.#initialTimerHandle);
      this.#initialTimerHandle = null;
    }
    if (this.#intervalHandle) {
      clearInterval(this.#intervalHandle);
      this.#intervalHandle = null;
    }
    this.#started = false;
  }

  getStatus() {
    return this.#lastStatus;
  }

  /**
   * Triggered by the renderer when the user clicks "Restart" on the banner.
   * isSilent=true, isForceRunAfter=true is the standard combination for a
   * user-initiated restart-to-update.
   */
  quitAndInstall() {
    if (!this.#app.isPackaged) {
      this.#logger.warn("[rez-chat:updater] quitAndInstall ignored in dev");
      return;
    }
    if (this.#lastStatus.state !== "downloaded") {
      this.#logger.warn(
        `[rez-chat:updater] quitAndInstall ignored — last state is ${this.#lastStatus.state}`,
      );
      return;
    }
    autoUpdater.quitAndInstall(true, true);
  }

  async checkNow() {
    if (!this.#app.isPackaged) return null;
    return this.#runCheck("manual");
  }

  async #runCheck(reason) {
    try {
      const result = await autoUpdater.checkForUpdates();
      return result;
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      this.#logger.warn(`[rez-chat:updater] check (${reason}) failed: ${message}`);
      this.#emit({ state: "error", message });
      return null;
    }
  }

  #wireEvents() {
    autoUpdater.on("checking-for-update", () => {
      this.#emit({ state: "checking" });
    });
    autoUpdater.on("update-available", (info) => {
      this.#emit({
        state: "available",
        version: info && info.version ? String(info.version) : null,
      });
    });
    autoUpdater.on("update-not-available", (info) => {
      this.#emit({
        state: "not-available",
        version: info && info.version ? String(info.version) : null,
      });
    });
    autoUpdater.on("download-progress", (progress) => {
      const percent = progress && Number.isFinite(progress.percent) ? progress.percent : 0;
      const transferred = progress && Number.isFinite(progress.transferred) ? progress.transferred : 0;
      const total = progress && Number.isFinite(progress.total) ? progress.total : 0;
      this.#emit({
        state: "downloading",
        percent,
        transferred,
        total,
      });
    });
    autoUpdater.on("update-downloaded", (info) => {
      this.#emit({
        state: "downloaded",
        version: info && info.version ? String(info.version) : null,
        releaseName: info && info.releaseName ? String(info.releaseName) : null,
      });
    });
    autoUpdater.on("error", (err) => {
      const message = err && err.message ? err.message : String(err);
      this.#logger.warn(`[rez-chat:updater] autoUpdater error: ${message}`);
      this.#emit({ state: "error", message });
    });
  }

  #emit(status) {
    this.#lastStatus = status;
    const win = this.#getWindow();
    if (!win || typeof win.isDestroyed !== "function" || win.isDestroyed()) return;
    if (!win.webContents || typeof win.webContents.send !== "function") return;
    win.webContents.send(STATUS_CHANNEL, status);
  }

  #buildAutoUpdaterLogger() {
    const log = this.#logger;
    return {
      info: (msg) => { log.log(`[rez-chat:updater] ${msg}`); },
      warn: (msg) => { log.warn(`[rez-chat:updater] ${msg}`); },
      error: (msg) => { log.error(`[rez-chat:updater] ${msg}`); },
      debug: () => {},
    };
  }
}

export const DESKTOP_UPDATES_STATUS_CHANNEL = STATUS_CHANNEL;
