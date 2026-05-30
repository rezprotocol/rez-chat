import { BaseBusService } from "./BaseBusService.js";

const STATUS_PENDING = "pending";
const STATUS_RESOLVED = "resolved";
const STATUS_ERROR = "error";

/**
 * LinksService (renderer): proxy + in-memory cache for `links.unfurl`.
 *
 * The server is the cache of record (KV-backed, TTL'd, image bytes proxied
 * as data URLs). This class only de-duplicates concurrent unfurl requests
 * for the same URL across multiple message bubbles in the same session and
 * lets views subscribe to a per-URL "got the preview" callback.
 */
export class LinksService extends BaseBusService {
  #byUrl;

  constructor({ bus } = {}) {
    super({ bus });
    this.#byUrl = new Map();
    this._register("links", "getPreview", (payload) => Promise.resolve(this.getPreview(payload)));
    this._register("links", "unfurl", (payload) => this.unfurl(payload));
  }

  _getClient() {
    return this.bus.runtime && this.bus.runtime.client ? this.bus.runtime.client : null;
  }

  /** Synchronously returns the in-memory entry, or null. */
  getPreview({ url } = {}) {
    const key = String(url || "").trim();
    if (!key) return null;
    return this.#byUrl.get(key) || null;
  }

  /**
   * Returns a Promise resolving to `{ status, preview, error }`.
   * Concurrent calls for the same URL share one in-flight server request.
   */
  unfurl({ url } = {}) {
    const key = String(url || "").trim();
    if (!key) return Promise.resolve({ status: STATUS_ERROR, preview: null, error: "empty_url" });

    const cached = this.#byUrl.get(key);
    if (cached && cached.promise) return cached.promise;
    if (cached && cached.status === STATUS_RESOLVED) {
      return Promise.resolve({ status: STATUS_RESOLVED, preview: cached.preview, error: "" });
    }
    if (cached && cached.status === STATUS_ERROR) {
      return Promise.resolve({ status: STATUS_ERROR, preview: cached.preview || null, error: cached.error || "" });
    }

    const client = this._getClient();
    if (!client) {
      const entry = { status: STATUS_ERROR, preview: null, error: "no_runtime" };
      this.#byUrl.set(key, entry);
      return Promise.resolve(entry);
    }

    const promise = client.call("links.unfurl", { url: key }).then((result) => {
      const preview = result && result.preview ? result.preview : null;
      const entry = preview && !preview.error
        ? { status: STATUS_RESOLVED, preview, error: "" }
        : { status: STATUS_ERROR, preview, error: preview && preview.error ? preview.error : "no_preview" };
      this.#byUrl.set(key, entry);
      this.bus.emit("link.preview.resolved", { url: key, preview });
      return entry;
    }).catch((err) => {
      const entry = { status: STATUS_ERROR, preview: null, error: err && err.message ? err.message : "fetch_failed" };
      this.#byUrl.set(key, entry);
      return entry;
    });

    this.#byUrl.set(key, { status: STATUS_PENDING, preview: null, error: "", promise });
    return promise;
  }
}
