import { Tray, Menu, nativeImage, app } from "electron";

/**
 * System-tray (macOS menu bar) icon with an unread-message badge and a
 * click-to-open menu.
 *
 * - macOS: the icon is a template image (auto-tinted for light/dark menu bars
 *   and highlight); the tray title shows the count next to the icon AND
 *   app.dock.setBadge() paints the standard red dock badge. Left- or right-click
 *   opens the context menu.
 * - Other platforms: tooltip reflects the count (no native overlay).
 *
 * The source branding PNG is a 1024² canvas with the glyph in a smaller,
 * vertically-off-center box (lots of transparent padding). Drawn as-is the
 * menu-bar icon comes out tiny and shifted up, so #buildIcon crops to the
 * glyph's opaque bounds (centered, with a small even margin) before sizing.
 *
 * Click focuses the main window via the menu; the chat-server's lifecycle is
 * managed by `DesktopSupervisor`; this class doesn't talk to chatApp directly —
 * main.mjs calls `setUnreadCount(n)` whenever the global total changes.
 */
export class DesktopTray {
  #tray;
  #getWindow;
  #onCheckForUpdates;
  #unread;

  constructor({ iconPath, getWindow, onCheckForUpdates } = {}) {
    if (!iconPath) throw new Error("DesktopTray requires iconPath");
    if (typeof getWindow !== "function") throw new Error("DesktopTray requires getWindow");
    this.#getWindow = getWindow;
    this.#onCheckForUpdates = typeof onCheckForUpdates === "function" ? onCheckForUpdates : null;
    this.#unread = 0;

    this.#tray = new Tray(this.#buildIcon(iconPath));
    this.#tray.setToolTip("Rez Chat");
    // setContextMenu makes the menu open on both left- and right-click (the
    // standard macOS menu-bar pattern), so no separate click handler is needed.
    this.#rebuildMenu();
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
    // Keep the menu's unread line in sync with the badge.
    this.#rebuildMenu();
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

  // Load the branding PNG, crop away its transparent padding so the glyph fills
  // the icon, and return a template image backed by a @2x raster (crisp on
  // Retina). On macOS the menu bar tints template images automatically.
  #buildIcon(iconPath) {
    const src = nativeImage.createFromPath(iconPath);
    if (src.isEmpty()) {
      throw new Error("DesktopTray: failed to load icon at " + iconPath);
    }
    const glyph = this.#cropToGlyph(src) || src;
    // 18pt on macOS / 16pt elsewhere, rasterized at 2x for sharpness. Building
    // from a @2x buffer (scaleFactor 2) keeps the logical point size correct.
    const points = process.platform === "darwin" ? 18 : 16;
    const px = points * 2;
    const buffer = glyph.resize({ width: px, height: px, quality: "best" }).toPNG();
    const image = nativeImage.createFromBuffer(buffer, { scaleFactor: 2 });
    if (process.platform === "darwin") image.setTemplateImage(true);
    return image;
  }

  // Find the opaque bounding box (alpha > 0) and return a centered square crop
  // around it with a small even margin, so the glyph isn't tiny/off-center.
  // Returns null (skip cropping) if the image is fully transparent or a square
  // crop can't fit — the caller falls back to the original image.
  #cropToGlyph(image) {
    const size = image.getSize();
    const w = size.width;
    const h = size.height;
    if (!w || !h) return null;
    const bmp = image.getBitmap();
    if (!bmp || bmp.length < w * h * 4) return null;

    let minX = w;
    let minY = h;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < h; y++) {
      const rowBase = y * w * 4;
      for (let x = 0; x < w; x++) {
        // BGRA: alpha is the 4th byte of each pixel.
        if (bmp[rowBase + x * 4 + 3] > 0) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < minX || maxY < minY) return null;

    const glyphW = maxX - minX + 1;
    const glyphH = maxY - minY + 1;
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    // ~8% margin on each side around the larger glyph dimension.
    const side = Math.round(Math.max(glyphW, glyphH) * 1.16);
    if (side > w || side > h) return null;

    let x = Math.round(centerX - side / 2);
    let y = Math.round(centerY - side / 2);
    if (x < 0) x = 0;
    if (y < 0) y = 0;
    if (x + side > w) x = w - side;
    if (y + side > h) y = h - side;
    return image.crop({ x, y, width: side, height: side });
  }

  #rebuildMenu() {
    if (!this.#tray) return;
    const n = this.#unread;
    const unreadLabel = n > 0
      ? (n > 99 ? "99+ unread" : n + (n === 1 ? " unread message" : " unread messages"))
      : "No unread messages";
    const template = [
      { label: "Open Rez", click: () => this.#focusWindow() },
      { type: "separator" },
      { label: unreadLabel, enabled: false },
      { type: "separator" },
    ];
    if (this.#onCheckForUpdates) {
      template.push({ label: "Check for Updates…", click: () => this.#onCheckForUpdates() });
    }
    template.push({ label: "Quit Rez", click: () => app.quit() });
    this.#tray.setContextMenu(Menu.buildFromTemplate(template));
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
