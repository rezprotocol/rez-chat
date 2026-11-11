import { h } from "@rezprotocol/ui";

export class BrowserUpdateBannerView {
  #rootEl = null;
  #entry = "";
  #dismissed = "";

  setUpdate(entryUrl) {
    if (typeof entryUrl !== "string") throw new Error("Browser update entry must be a string");
    this.#entry = entryUrl;
    if (!entryUrl) {
      this.#dismissed = "";
      this.#hide();
      return;
    }
    if (entryUrl === this.#dismissed || this.#rootEl) return;
    const refresh = h("button", {
      type: "button",
      className: "shrink-0 rounded-lg bg-primary px-3 py-2 text-on-primary font-label-technical",
      "data-testid": "browserUpdate.refresh",
    }, "Refresh");
    refresh.addEventListener("click", () => {
      const input = document.querySelector('[data-testid="composer.input"]');
      const attachment = document.querySelector('[data-testid="composer.attachment"]');
      const hasDraft = Boolean((input && input.value.trim()) || (attachment && attachment.childElementCount > 0));
      if (hasDraft && !window.confirm("Refreshing will discard your unsent message or attachment. Saved messages and your account will stay. Refresh now?")) return;
      refresh.disabled = true;
      try {
        window.location.reload();
      } catch (error) {
        refresh.disabled = false;
        console.warn("[BrowserUpdateBannerView] refresh failed", error);
        refresh.textContent = "Try refresh again";
      }
    });
    const later = h("button", {
      type: "button",
      className: "shrink-0 rounded-lg px-3 py-2 text-on-surface-variant hover:text-on-surface font-label-technical",
      "data-testid": "browserUpdate.later",
    }, "Later");
    later.addEventListener("click", () => {
      this.#dismissed = this.#entry;
      this.#hide();
    });
    this.#rootEl = h("aside", {
      className: "fixed top-4 left-1/2 -translate-x-1/2 z-[70] w-[calc(100%_-_2rem)] max-w-xl flex flex-wrap items-center gap-3 rounded-xl border border-primary/40 bg-surface-container-high px-4 py-3 shadow-2xl",
      role: "status",
      "aria-live": "polite",
      "aria-atomic": "true",
      "data-testid": "browserUpdate.banner",
    }, [
      h("div", { className: "flex-1 min-w-0" }, [
        h("p", { className: "font-medium text-on-surface" }, "New version available"),
        h("p", { className: "text-body-sm text-on-surface-variant" }, "Refresh to get the latest version of Rez Chat."),
      ]),
      refresh,
      later,
    ]);
    document.body.appendChild(this.#rootEl);
  }

  stop() {
    this.#entry = "";
    this.#dismissed = "";
    this.#hide();
  }

  #hide() {
    if (this.#rootEl) this.#rootEl.remove();
    this.#rootEl = null;
  }
}
