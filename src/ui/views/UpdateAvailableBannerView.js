import { h } from "@rezprotocol/ui";
import { materialIcon } from "../base/icon.js";

/**
 * UpdateAvailableBannerView
 *
 * Renders a fixed-position "Update ready — Restart" banner when the desktop
 * updater reports state === "downloaded". Subscribes directly to
 * window.rezDesktop.updates.onStatus(...) — purely IPC main↔renderer, no bus
 * involvement (this is not chat-protocol traffic).
 *
 * In non-desktop environments (web build, missing preload bridge), start()
 * is a no-op so the view is safe to instantiate unconditionally.
 */
export class UpdateAvailableBannerView {
  #rootEl;
  #offStatus;
  #lastVersion;
  #busy;

  constructor() {
    this.#rootEl = null;
    this.#offStatus = null;
    this.#lastVersion = null;
    this.#busy = false;
  }

  start() {
    const bridge = this.#getBridge();
    if (!bridge) return;
    this.#offStatus = bridge.onStatus((status) => this.#onStatus(status));
    bridge.getStatus().then((status) => {
      if (status && typeof status === "object") this.#onStatus(status);
    }).catch((err) => {
      console.warn("[UpdateAvailableBannerView] getStatus failed", err && err.message ? err.message : err);
    });
  }

  stop() {
    if (typeof this.#offStatus === "function") {
      this.#offStatus();
      this.#offStatus = null;
    }
    this.#hide();
  }

  #getBridge() {
    if (typeof window === "undefined") return null;
    const desktop = window.rezDesktop;
    if (!desktop || !desktop.updates) return null;
    const u = desktop.updates;
    if (typeof u.onStatus !== "function") return null;
    if (typeof u.getStatus !== "function") return null;
    if (typeof u.restartAndInstall !== "function") return null;
    return u;
  }

  #onStatus(status) {
    if (!status || typeof status !== "object") return;
    if (status.state === "downloaded") {
      const version = status.version ? String(status.version) : null;
      this.#show(version);
    }
  }

  #show(version) {
    if (this.#rootEl) {
      if (version && version !== this.#lastVersion) this.#updateLabel(version);
      return;
    }
    this.#lastVersion = version;
    const label = h("span", {
      className: "text-label-small font-label-technical text-on-surface",
    }, version ? `Update ready · v${version}` : "Update ready");

    const restartBtn = h("button", {
      type: "button",
      className: "ml-3 px-3 py-1 rounded-md bg-primary text-on-primary text-label-small font-label-technical hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed",
      "data-testid": "updateBanner.restart",
    }, "Restart");
    restartBtn.addEventListener("click", () => this.#onRestart(restartBtn));

    const dismissBtn = h("button", {
      type: "button",
      className: "ml-2 p-1 rounded-md text-on-surface-variant hover:text-on-surface transition-colors",
      "aria-label": "Dismiss",
      "data-testid": "updateBanner.dismiss",
    }, materialIcon("close", { weight: "regular", size: 16 }));
    dismissBtn.addEventListener("click", () => this.#hide());

    this.#rootEl = h("div", {
      className: "fixed bottom-4 right-4 z-[60] flex items-center px-4 py-2 rounded-lg border border-outline-variant/30 bg-surface-container-high shadow-2xl",
      role: "status",
      "data-role": "update-available-banner",
    }, [
      materialIcon("system_update", { weight: "fill", size: 18 }),
      h("span", { className: "ml-2" }, label),
      restartBtn,
      dismissBtn,
    ]);
    document.body.appendChild(this.#rootEl);
  }

  #updateLabel(version) {
    if (!this.#rootEl) return;
    this.#lastVersion = version;
    const span = this.#rootEl.querySelector("[data-testid='updateBanner.restart']");
    if (!span) return;
    const label = this.#rootEl.querySelector("span > span");
    if (label) label.textContent = version ? `Update ready · v${version}` : "Update ready";
  }

  #hide() {
    if (!this.#rootEl) return;
    this.#rootEl.remove();
    this.#rootEl = null;
  }

  async #onRestart(buttonEl) {
    if (this.#busy) return;
    this.#busy = true;
    if (buttonEl) buttonEl.setAttribute("disabled", "");
    const bridge = this.#getBridge();
    if (!bridge) {
      this.#busy = false;
      if (buttonEl) buttonEl.removeAttribute("disabled");
      return;
    }
    try {
      await bridge.restartAndInstall();
    } catch (err) {
      console.warn("[UpdateAvailableBannerView] restartAndInstall failed", err && err.message ? err.message : err);
      this.#busy = false;
      if (buttonEl) buttonEl.removeAttribute("disabled");
    }
  }
}
