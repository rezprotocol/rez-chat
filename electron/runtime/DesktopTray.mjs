import { Tray, nativeImage, app } from "electron";

/**
 * System-tray icon with an unread-message badge.
 *
 * - macOS: tray title shows the count next to the icon AND app.dock.setBadge()
 *   paints the standard red dock badge.
 * - Other platforms: tooltip text reflects the count (no native overlay).
 *
 * Click focuses the main window. The chat-server's lifecycle is managed by
 * `DesktopSupervisor`; this class doesn't talk to chatApp directly — main.mjs
 * calls `setUnreadCount(n)` whenever the global total changes.
 */
export class DesktopTray {
  #tray;
  #getWindow;
  #unread;

  constructor({ iconPath, getWindow } = {}) {
    if (!iconPath) throw new Error("DesktopTray requires iconPath");
    if (typeof getWindow !== "function") throw new Error("DesktopTray requires getWindow");
    this.#getWindow = getWindow;
    this.#unread = 0;

    const raw = nativeImage.createFromPath(iconPath);
    if (raw.isEmpty()) {
      throw new Error("DesktopTray: failed to load icon at " + iconPath);
    }
    const sized = process.platform === "darwin"
      ? raw.resize({ width: 18, height: 18 })
      : raw.resize({ width: 16, height: 16 });
    // Template images render correctly against the macOS light/dark menu bar.
    if (process.platform === "darwin") sized.setTemplateImage(true);

    this.#tray = new Tray(sized);
    this.#tray.setToolTip("Rez Chat");
    this.#tray.on("click", () => this.#focusWindow());
    this.#tray.on("right-click", () => this.#focusWindow());
  }

  setUnreadCount(count) {
    const n = Math.max(0, Math.floor(Number(count) || 0));
    if (n === this.#unread) return;
    this.#unread = n;
    const label = n > 99 ? "99+" : String(n);
    this.#tray.setToolTip(n > 0 ? "Rez Chat — " + label + " unread" : "Rez Chat");
    if (process.platform === "darwin") {
      this.#tray.setTitle(n > 0 ? label : "");
      if (app.dock && typeof app.dock.setBadge === "function") {
        app.dock.setBadge(n > 0 ? label : "");
      }
    }
  }

  destroy() {
    if (this.#tray) {
      this.#tray.destroy();
      this.#tray = null;
    }
    if (process.platform === "darwin" && app.dock && typeof app.dock.setBadge === "function") {
      app.dock.setBadge("");
    }
  }

  #focusWindow() {
    const win = this.#getWindow();
    if (!win) return;
    if (typeof win.isMinimized === "function" && win.isMinimized()) win.restore();
    if (typeof win.isVisible === "function" && !win.isVisible() && typeof win.show === "function") {
      win.show();
    }
    if (typeof win.focus === "function") win.focus();
  }
}
