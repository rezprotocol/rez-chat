import electronUpdater from "electron-updater";


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
  #updater;

  constructor({ app, logger, getWindow, updater } = {}) {
    if (!app || typeof app.isPackaged !== "boolean") {
      throw new Error("DesktopUpdater requires the Electron app");
    }
    if (typeof getWindow !== "function") {
      throw new Error("DesktopUpdater requires getWindow()");
    }
    this.#app = app;
    this.#logger = logger && typeof logger.warn === "function" ? logger : console;
    this.#getWindow = getWindow;
    // The electron-updater autoUpdater by default; injectable for tests.
    this.#updater = updater || electronUpdater.autoUpdater;
    this.#started = false;
    this.#intervalHandle = null;
    this.#initialTimerHandle = null;
    this.#lastStatus = { state: "idle" };
  }

  /**
   * Load-phase update gate. Check for an update and, if one exists, download +
   * install it (the app relaunches) BEFORE the caller connects to reznet —
   * so a stale client updates here instead of failing against relays it's no
   * longer compatible with.
   *
   * Resolves `{ applying: true }` when an update is being applied (the app is
   * about to quit + relaunch into the new version), or `{ applying: false }`
   * when there is nothing to do: no update, dev mode, or a failed/offline/
   * slow check. It NEVER rejects — a failed update check must not block
   * startup; the app should still open (offline).
   *
   * @param {{ setStatus?: (message: string) => void, timeoutMs?: number }} [opts]
   * @returns {Promise<{ applying: boolean }>}
   */
  async checkAndApplyDuringLoad({ setStatus = () => {}, timeoutMs = 20_000 } = {}) {
    if (!this.#app.isPackaged) {
      this.#logger.log("[rez-chat:updater] dev mode — skipping load-phase update gate");
      return { applying: false };
    }
    const up = this.#updater;
    up.logger = this.#buildAutoUpdaterLogger();
    up.autoDownload = true;
    up.autoInstallOnAppQuit = false;

    return new Promise((resolve) => {
      let settled = false;
      let checkTimer = setTimeout(() => {
        this.#logger.warn("[rez-chat:updater] load-phase update check timed out — continuing (offline)");
        finish({ applying: false });
      }, timeoutMs);

      const cleanup = () => {
        up.removeListener("update-not-available", onNotAvailable);
        up.removeListener("download-progress", onProgress);
        up.removeListener("update-downloaded", onDownloaded);
        up.removeListener("error", onError);
        if (checkTimer) { clearTimeout(checkTimer); checkTimer = null; }
      };
      const finish = (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      };
      const onNotAvailable = () => {
        this.#emit({ state: "not-available" });
        finish({ applying: false });
      };
      const onProgress = (p) => {
        // An update was found and is downloading — drop the check timeout and
        // let it finish, surfacing progress on the splash (downloads can be
        // large and slow).
        if (checkTimer) { clearTimeout(checkTimer); checkTimer = null; }
        const percent = p && Number.isFinite(p.percent) ? Math.round(p.percent) : 0;
        this.#emit({ state: "downloading", percent });
        setStatus(`Downloading update… ${percent}%`);
      };
      const onDownloaded = (info) => {
        this.#emit({ state: "downloaded", version: info && info.version ? String(info.version) : null });
        setStatus("Installing update…");
        finish({ applying: true });
        // Let the splash paint "Installing…" before we quit + relaunch.
        setTimeout(() => {
          try { up.quitAndInstall(true, true); }
          catch (err) { this.#logger.error("[rez-chat:updater] quitAndInstall failed", err && err.message ? err.message : err); }
        }, 250);
      };
      const onError = (err) => {
        const message = err && err.message ? err.message : String(err);
        this.#logger.warn(`[rez-chat:updater] load-phase update check failed: ${message}`);
        this.#emit({ state: "error", message });
        finish({ applying: false }); // never block startup on a failed check
      };

      up.on("update-not-available", onNotAvailable);
      up.on("download-progress", onProgress);
      up.on("update-downloaded", onDownloaded);
      up.on("error", onError);
      setStatus("Checking for updates…");
      Promise.resolve(up.checkForUpdates()).catch((err) => onError(err));
    });
  }

  start() {
    if (this.#started) return;
    if (!this.#app.isPackaged) {
      this.#logger.log("[rez-chat:updater] dev mode — auto-update disabled");
      return;
    }
    this.#started = true;
    this.#updater.logger = this.#buildAutoUpdaterLogger();
    this.#updater.autoDownload = true;
    this.#updater.autoInstallOnAppQuit = false;
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
    this.#updater.quitAndInstall(true, true);
  }

  async checkNow() {
    if (!this.#app.isPackaged) return null;
    return this.#runCheck("manual");
  }

  async #runCheck(reason) {
    try {
      const result = await this.#updater.checkForUpdates();
      return result;
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      this.#logger.warn(`[rez-chat:updater] check (${reason}) failed: ${message}`);
      this.#emit({ state: "error", message });
      return null;
    }
  }

  #wireEvents() {
    this.#updater.on("checking-for-update", () => {
      this.#emit({ state: "checking" });
    });
    this.#updater.on("update-available", (info) => {
      this.#emit({
        state: "available",
        version: info && info.version ? String(info.version) : null,
      });
    });
    this.#updater.on("update-not-available", (info) => {
      this.#emit({
        state: "not-available",
        version: info && info.version ? String(info.version) : null,
      });
    });
    this.#updater.on("download-progress", (progress) => {
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
    this.#updater.on("update-downloaded", (info) => {
      this.#emit({
        state: "downloaded",
        version: info && info.version ? String(info.version) : null,
        releaseName: info && info.releaseName ? String(info.releaseName) : null,
      });
    });
    this.#updater.on("error", (err) => {
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
