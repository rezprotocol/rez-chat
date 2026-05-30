import { RRecord } from "@rezprotocol/sdk/client";
import { nonEmptyString, toFiniteNumber } from "./coerce.js";

/**
 * LinkPreview: cached OpenGraph metadata for a URL.
 *
 * Populated server-side by ServerLinksService after fetching the page and
 * parsing OG / Twitter card meta tags. `imageDataUrl` carries the actual
 * image bytes as a base64 data URL so the renderer can paint the card
 * without broadening its CSP (img-src 'self' data: only) and without
 * leaking the recipient's IP to arbitrary preview hosts.
 *
 * `error` is non-empty when the fetch failed; cache an error result with a
 * shorter TTL so transient failures auto-retry.
 */
export class LinkPreview extends RRecord {
  static type = "chat.link.preview";

  constructor(raw = {}) {
    super();
    this.url = nonEmptyString(raw.url);
    this.canonicalUrl = nonEmptyString(raw.canonicalUrl) || this.url;
    this.title = String(raw.title == null ? "" : raw.title);
    this.description = String(raw.description == null ? "" : raw.description);
    this.siteName = String(raw.siteName == null ? "" : raw.siteName);
    this.imageDataUrl = String(raw.imageDataUrl == null ? "" : raw.imageDataUrl);
    this.fetchedAtMs = toFiniteNumber(raw.fetchedAtMs, 0);
    this.error = String(raw.error == null ? "" : raw.error);
    if (this.title.length > 512) this.title = this.title.slice(0, 512);
    if (this.description.length > 1024) this.description = this.description.slice(0, 1024);
    if (this.siteName.length > 256) this.siteName = this.siteName.slice(0, 256);
    if (this.error.length > 256) this.error = this.error.slice(0, 256);
    this._seal();
  }

  validate() {
    this.assert(this.url.length > 0, "LinkPreview requires url");
    this.assert(this.fetchedAtMs > 0, "LinkPreview requires fetchedAtMs");
  }
}
