const CHECK_INTERVAL_MS = 60_000;
const CHECK_TIMEOUT_MS = 10_000;
const MAX_SHELL_CHARS = 256 * 1024;

function appEntryUrl(value, baseUrl) {
  try {
    const base = new URL(baseUrl);
    const url = new URL(value, base);
    if (url.origin !== base.origin || url.search || url.hash) return "";
    return /^\/assets\/[A-Za-z0-9_-]+\.js$/.test(url.pathname) ? url.href : "";
  } catch {
    return "";
  }
}

// The generated HTML's external module entry is the build identity. No new
// version endpoint, application record or protocol message is needed.
export function browserEntryUrl(html, baseUrl) {
  if (typeof html !== "string" || html.length > MAX_SHELL_CHARS) return "";
  for (const match of html.matchAll(/<script\b[^>]*>/gi)) {
    if (!/\stype\s*=\s*(["'])module\1/i.test(match[0])) continue;
    const src = /\ssrc\s*=\s*(["'])(.*?)\1/i.exec(match[0]);
    if (src) return appEntryUrl(src[2], baseUrl);
  }
  return "";
}

export class BrowserUpdateService {
  #onUpdate;
  #window;
  #document;
  #fetch;
  #active = false;
  #epoch = 0;
  #runningEntry = "";
  #timer = null;
  #controller = null;
  #pending = null;
  #probe = 0;
  #failed = false;
  #wake;

  constructor(onUpdate) {
    if (typeof onUpdate !== "function") throw new Error("BrowserUpdateService requires an update callback");
    this.#onUpdate = onUpdate;
    this.#window = globalThis.window;
    this.#document = globalThis.document;
    this.#fetch = globalThis.fetch.bind(globalThis);
    this.#wake = () => {
      if (this.#document.visibilityState === "hidden") {
        this.#clearTimer();
        return;
      }
      void this.check();
    };
  }

  start(entryUrl = "") {
    if (typeof entryUrl !== "string") throw new Error("Browser update entry must be a string");
    this.stop();
    if (!/^https?:$/.test(this.#window.location.protocol)) return false;
    const script = this.#document.querySelector('script[type="module"][src]');
    this.#runningEntry = appEntryUrl(entryUrl || (script ? script.src : ""), this.#window.location.href);
    // Development source modules have no immutable build identity.
    if (!this.#runningEntry) return false;
    this.#active = true;
    this.#window.addEventListener("focus", this.#wake);
    this.#window.addEventListener("online", this.#wake);
    this.#document.addEventListener("visibilitychange", this.#wake);
    void this.check();
    return true;
  }

  check() {
    if (!this.#active || this.#document.visibilityState === "hidden") return Promise.resolve("");
    if (this.#pending) return this.#pending;
    this.#clearTimer();
    const epoch = this.#epoch;
    const pending = this.#checkEntry(epoch).finally(() => {
      if (epoch !== this.#epoch) return;
      this.#pending = null;
      if (this.#active && this.#document.visibilityState !== "hidden") {
        this.#timer = this.#window.setTimeout(() => {
          this.#timer = null;
          void this.check();
        }, CHECK_INTERVAL_MS);
      }
    });
    this.#pending = pending;
    return pending;
  }

  stop() {
    this.#active = false;
    this.#epoch += 1;
    this.#clearTimer();
    if (this.#controller) this.#controller.abort();
    this.#controller = null;
    this.#pending = null;
    this.#failed = false;
    this.#window.removeEventListener("focus", this.#wake);
    this.#window.removeEventListener("online", this.#wake);
    this.#document.removeEventListener("visibilitychange", this.#wake);
    this.#onUpdate("");
  }

  #clearTimer() {
    if (this.#timer !== null) this.#window.clearTimeout(this.#timer);
    this.#timer = null;
  }

  async #checkEntry(epoch) {
    const controller = new AbortController();
    this.#controller = controller;
    const timeout = this.#window.setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
    try {
      const url = new URL("/", this.#window.location.href);
      // Also defeats the previous worker's cache-first fetch handler during
      // the brief transition before the new no-store-aware worker activates.
      url.searchParams.set("__rez_update_check", Date.now().toString(36) + "-" + (++this.#probe));
      const response = await this.#fetch(url.href, {
        cache: "no-store", credentials: "omit", redirect: "error", signal: controller.signal,
      });
      if (!response.ok) throw new Error("Browser update check returned HTTP " + response.status);
      if (!(response.headers.get("content-type") || "").toLowerCase().includes("text/html")) {
        throw new Error("Browser update check did not return HTML");
      }
      const entry = browserEntryUrl(await response.text(), url.href);
      if (!entry) throw new Error("Browser update check returned no valid application entry");
      if (!this.#active || epoch !== this.#epoch || controller.signal.aborted || this.#document.visibilityState === "hidden") return "";
      this.#failed = false;
      this.#onUpdate(entry === this.#runningEntry ? "" : entry);
      return entry;
    } catch (error) {
      if (this.#active && epoch === this.#epoch && this.#document.visibilityState !== "hidden" && !this.#failed) {
        console.warn("[BrowserUpdateService] update check failed; will retry", error);
        this.#failed = true;
      }
      return "";
    } finally {
      this.#window.clearTimeout(timeout);
      if (this.#controller === controller) this.#controller = null;
    }
  }
}
