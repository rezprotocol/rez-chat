import { createHash } from "node:crypto";
import { LinkPreview } from "../../records/domain/LinkPreview.js";

export const LINK_PREVIEW_PREFIX = "app:linkpreviews/";

// Successful previews stay cached for 7 days; failed fetches retry after
// 1 hour so transient outages don't permanently poison a URL.
const DEFAULT_OK_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_ERROR_TTL_MS = 60 * 60 * 1000;

function urlKey(url) {
  const h = createHash("sha256").update(String(url)).digest("base64url");
  return LINK_PREVIEW_PREFIX + h.slice(0, 32);
}

/**
 * LinkPreviewStore: cache of OG metadata keyed by URL hash.
 *
 * Successful previews live `DEFAULT_OK_TTL_MS`; previews carrying an error
 * (fetch failure / parse failure) live `DEFAULT_ERROR_TTL_MS` so transient
 * failures auto-retry. `get()` returns null when the cached entry has aged
 * out — callers treat that the same as a cache miss.
 */
export class LinkPreviewStore {
  #kv;
  #clock;
  #okTtlMs;
  #errorTtlMs;

  constructor({
    storageProvider,
    clock = () => Date.now(),
    okTtlMs = DEFAULT_OK_TTL_MS,
    errorTtlMs = DEFAULT_ERROR_TTL_MS,
  } = {}) {
    if (!storageProvider || typeof storageProvider.getKeyValueStore !== "function") {
      throw new Error("LinkPreviewStore requires storageProvider.getKeyValueStore()");
    }
    this.#kv = storageProvider.getKeyValueStore(null);
    this.#clock = clock;
    this.#okTtlMs = okTtlMs;
    this.#errorTtlMs = errorTtlMs;
  }

  async get(url) {
    const key = urlKey(url);
    const raw = await this.#kv.get(key);
    if (!raw || typeof raw !== "object") return null;
    let preview;
    try {
      preview = new LinkPreview(raw);
    } catch {
      return null;
    }
    const age = this.#clock() - preview.fetchedAtMs;
    const ttl = preview.error ? this.#errorTtlMs : this.#okTtlMs;
    if (age > ttl) return null;
    return preview;
  }

  async put(preview) {
    if (!(preview instanceof LinkPreview)) {
      throw new Error("LinkPreviewStore.put: expected LinkPreview");
    }
    await this.#kv.set(urlKey(preview.url), preview.toJSON());
  }
}
