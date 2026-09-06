import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import { SlidingWindowRateLimiter } from "@rezprotocol/node";
import { LinksUnfurlParams, LinksUnfurlResult } from "../../records/index.js";
import { LinkPreview } from "../../records/domain/LinkPreview.js";
import { BaseServerService } from "../base/BaseServerService.js";

const FETCH_TIMEOUT_MS = 6000;
const HTML_BYTE_LIMIT = 512 * 1024;       // 512 KiB of HTML is plenty for <head>.
const IMAGE_BYTE_LIMIT = 256 * 1024;      // 256 KiB binary → ~342 KiB base64 (SECURITY_AUDIT MED-15).
const MAX_REDIRECTS = 3;                  // SECURITY_AUDIT HIGH-10 + MED-15.
const TEXT_FIELD_MAX_LEN = 1024;          // OG title/description/siteName length cap.
const USER_AGENT = "RezChat/1.0 (+link-preview)";
const ACCEPT_LANGUAGE = "en-US,en;q=0.9";

const ALLOWED_IMAGE_TYPES = new Set([
  "image/png", "image/jpeg", "image/jpg",
  "image/gif", "image/webp", "image/svg+xml",
]);

// SECURITY_AUDIT MED-15c: per-owner unfurl rate limit. A compromised renderer
// or a flood of attacker-crafted URLs in incoming messages can otherwise drive
// arbitrary outbound HTTP from this server. 100 unique-URL unfurls per 5min is
// well above any organic message flow.
const UNFURL_RATE_LIMITER = new SlidingWindowRateLimiter({
  windowMs: 5 * 60_000,
  maxAttempts: 100,
});

const dnsLookup = promisify(dns.lookup);
const NON_PUBLIC_IPV4 = new net.BlockList();
const NON_PUBLIC_IPV6 = new net.BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4],
  ["240.0.0.0", 4],
]) {
  NON_PUBLIC_IPV4.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 128], ["::1", 128], ["::ffff:0:0", 96], ["64:ff9b:1::", 48],
  ["100::", 64], ["2001::", 23], ["2002::", 16], ["3fff::", 20],
  ["5f00::", 16], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
]) {
  NON_PUBLIC_IPV6.addSubnet(network, prefix, "ipv6");
}

/**
 * ServerLinksService: opaque http(s) URL → cached OpenGraph preview.
 *
 * Server-side fetch keeps three things sane:
 *   1. CSP — the renderer's connect-src stays locked to ws:/wss:/self.
 *   2. Privacy — OG image bytes are proxied as data URLs so the recipient's
 *      IP is never disclosed to arbitrary preview hosts.
 *   3. SSRF — URLs are denied if (a) the parsed hostname matches a
 *      private/loopback string pattern, OR (b) DNS resolves to any A/AAAA
 *      address in the denylist. Redirects are followed manually with the
 *      same checks re-applied at each hop. See SECURITY_AUDIT HIGH-10.
 *
 * The KV-backed LinkPreviewStore TTLs successes for 7d and failures for 1h.
 */
export class ServerLinksService extends BaseServerService {
  #store;
  #clock;
  #fetch;
  #dnsLookup;

  constructor({
    bus,
    linkPreviewStore,
    ownerAccountId = null,
    clock = () => Date.now(),
    fetchImpl = null,
    dnsLookupImpl = dnsLookup,
    logger = console,
  } = {}) {
    super({ bus, ownerAccountId, logger });
    if (!linkPreviewStore) throw new Error("ServerLinksService requires linkPreviewStore");
    this.#store = linkPreviewStore;
    this.#clock = clock;
    this.#fetch = typeof fetchImpl === "function" ? fetchImpl : fetchPinnedUrl;
    if (typeof dnsLookupImpl !== "function") throw new Error("ServerLinksService requires dnsLookupImpl");
    this.#dnsLookup = dnsLookupImpl;
    this._register("links", "unfurl", (payload) => this.unfurl(payload));
  }

  async unfurl(payload = {}) {
    const params = this._coerceParams(payload, LinksUnfurlParams);
    params.validate();
    const url = params.url;
    if (!isSafeHttpUrl(url)) {
      throw new Error("links.unfurl: rejected url '" + url + "' (must be http/https, no credentials, no private host)");
    }
    // Per-owner rate limit before any expensive work. Empty ownerAccountId
    // (tests, anonymous bootstrap) skips the gate.
    const owner = this.ownerAccountId;
    if (owner && !UNFURL_RATE_LIMITER.record(owner, this.#clock())) {
      throw new Error("links.unfurl: rate limit exceeded");
    }
    if (!params.forceRefresh) {
      const cached = await this.#store.get(url);
      if (cached) {
        return new LinksUnfurlResult({ preview: cached, cached: true });
      }
    }
    const preview = await this.#fetchPreview(url);
    await this.#store.put(preview).catch((err) => {
      this.logger.warn("[ServerLinksService] cache put failed",
        err && err.message ? err.message : err);
    });
    return new LinksUnfurlResult({ preview, cached: false });
  }

  async #fetchPreview(url) {
    if (!this.#fetch) {
      return new LinkPreview({
        url,
        fetchedAtMs: this.#clock(),
        error: "fetch_unavailable",
      });
    }
    let response;
    try {
      response = await this.#safeFetch(url, {
        headers: {
          "user-agent": USER_AGENT,
          "accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
          "accept-language": ACCEPT_LANGUAGE,
        },
      });
    } catch (err) {
      return new LinkPreview({
        url,
        fetchedAtMs: this.#clock(),
        error: shortError(err),
      });
    }
    if (!response.ok) {
      await cancelResponseBody(response);
      return new LinkPreview({
        url,
        fetchedAtMs: this.#clock(),
        error: "http_" + response.status,
      });
    }
    const contentType = String(response.headers.get("content-type") || "").toLowerCase();
    if (!contentType.includes("html") && !contentType.includes("xml")) {
      await cancelResponseBody(response);
      return new LinkPreview({
        url,
        canonicalUrl: String(response.url || url),
        fetchedAtMs: this.#clock(),
        error: "not_html",
      });
    }
    const html = await readCapped(response, HTML_BYTE_LIMIT).catch((err) => {
      this.logger.warn("[ServerLinksService] read body failed",
        err && err.message ? err.message : err);
      return "";
    });
    const finalUrl = String(response.url || url);
    const meta = parseOpenGraph(html);
    const imageUrl = absolutize(meta.image, finalUrl);
    let imageDataUrl = "";
    if (imageUrl && isSafeHttpUrl(imageUrl)) {
      imageDataUrl = await this.#fetchImageAsDataUrl(imageUrl).catch((err) => {
        this.logger.warn("[ServerLinksService] image fetch failed",
          err && err.message ? err.message : err);
        return "";
      });
    }
    return new LinkPreview({
      url,
      canonicalUrl: absolutize(meta.canonicalUrl, finalUrl) || finalUrl,
      title: meta.title,
      description: meta.description,
      siteName: meta.siteName,
      imageDataUrl,
      fetchedAtMs: this.#clock(),
    });
  }

  async #fetchImageAsDataUrl(imageUrl) {
    let response;
    try {
      response = await this.#safeFetch(imageUrl, {
        headers: { "user-agent": USER_AGENT },
      });
    } catch (err) {
      this.logger.warn("[ServerLinksService] image http error",
        err && err.message ? err.message : err);
      return "";
    }
    if (!response.ok) {
      await cancelResponseBody(response);
      return "";
    }
    const contentType = String(response.headers.get("content-type") || "").toLowerCase().split(";")[0].trim();
    if (!ALLOWED_IMAGE_TYPES.has(contentType)) {
      await cancelResponseBody(response);
      return "";
    }
    const buf = await readCappedBytes(response, IMAGE_BYTE_LIMIT);
    if (!buf || buf.length === 0) return "";
    const base64 = Buffer.from(buf).toString("base64");
    return "data:" + contentType + ";base64," + base64;
  }

  /**
   * Fetch with a manual redirect loop and a DNS-resolution SSRF guard at
   * each hop. Closes SECURITY_AUDIT HIGH-10: the previous string-level
   * `isSafeHttpUrl()` was bypassable via DNS rebinding (low-TTL DNS that
   * returns a public IP at lookup time and a private IP at fetch time)
   * and via `redirect: "follow"` to a private-IP Location URL.
   *
   * The request connects to the exact vetted address while preserving the
   * original Host header and TLS SNI. DNS is never resolved a second time.
   */
  async #safeFetch(initialUrl, init) {
    let url = initialUrl;
    let hops = 0;
    while (true) {
      const pinnedAddress = await resolveSafeUrlWithDns(url, this.#dnsLookup);
      const response = await fetchWithTimeout(this.#fetch, url, {
        ...init,
        redirect: "manual",
        pinnedAddress,
      }, FETCH_TIMEOUT_MS);
      const status = response.status;
      if (status >= 300 && status < 400) {
        const location = response.headers.get("location");
        if (!location) return response;
        await cancelResponseBody(response);
        hops += 1;
        if (hops > MAX_REDIRECTS) {
          throw new Error("too_many_redirects");
        }
        const nextUrl = absolutize(location, url);
        if (!nextUrl || !isSafeHttpUrl(nextUrl)) {
          throw new Error("unsafe_redirect");
        }
        url = nextUrl;
        continue;
      }
      return response;
    }
  }
}

function isSafeHttpUrl(raw) {
  let parsed;
  try {
    parsed = new URL(String(raw));
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  if (parsed.username || parsed.password) return false;
  const host = hostnameWithoutIpv6Brackets(parsed).toLowerCase();
  if (!host || host === "localhost") return false;
  // String-level SSRF pre-filter. The DNS-resolved IP is then checked in
  // assertSafeUrlWithDns(). Both guards are required: this one catches
  // literal-IP and obvious-pattern attacks before we spend a DNS lookup;
  // the DNS guard catches the remaining hostname-via-DNS attacks.
  if (host === "0.0.0.0" || host === "::" || host === "::1") return false;
  if (/^127\./.test(host)) return false;
  if (/^10\./.test(host)) return false;
  if (/^192\.168\./.test(host)) return false;
  if (/^169\.254\./.test(host)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
  if (host.endsWith(".local") || host.endsWith(".internal")) return false;
  return true;
}

/**
 * Resolve hostname via DNS and refuse the fetch if any A/AAAA record is
 * private, loopback, link-local, or otherwise non-routable on the public
 * internet. Required to close the DNS-rebinding bypass of isSafeHttpUrl
 * (SECURITY_AUDIT HIGH-10).
 */
async function resolveSafeUrlWithDns(rawUrl, lookup = dnsLookup) {
  const parsed = new URL(rawUrl);
  const host = hostnameWithoutIpv6Brackets(parsed);
  // Literal IP: pre-filter already rejected the common cases, but cover
  // the remainder (e.g. 100.64/10 CGNAT, fc00::/7 ULA, fe80::/10 link-local
  // expressed in compressed form).
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error("rejected_private_ip");
    return { address: host, family: net.isIP(host) };
  }
  let addrs;
  try {
    addrs = await lookup(host, { all: true });
  } catch (err) {
    throw new Error("dns_lookup_failed: " + (err && err.message ? err.message : "unknown"));
  }
  if (!Array.isArray(addrs) || addrs.length === 0) {
    throw new Error("dns_no_records");
  }
  for (const entry of addrs) {
    if (!entry || typeof entry.address !== "string" || (entry.family !== 4 && entry.family !== 6)) {
      throw new Error("dns_invalid_record");
    }
    if (isPrivateIp(entry.address)) {
      throw new Error("rejected_private_ip");
    }
  }
  return { address: addrs[0].address, family: addrs[0].family };
}

/**
 * IPv4 and IPv6 private/loopback/link-local check. Covers:
 *  - IPv4: 0.0.0.0, 127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16,
 *          169.254.0.0/16, 100.64.0.0/10 (CGNAT)
 *  - IPv6: ::, ::1, fc00::/7 (ULA), fe80::/10 (link-local), IPv4-mapped variants
 */
function isPrivateIp(addr) {
  if (typeof addr !== "string" || addr.length === 0) return true;
  const ipv = net.isIP(addr);
  if (ipv === 4) return NON_PUBLIC_IPV4.check(addr, "ipv4");
  if (ipv === 6) return NON_PUBLIC_IPV6.check(addr, "ipv6");
  return true; // not a parseable IP — fail closed
}

function hostnameWithoutIpv6Brackets(parsed) {
  const host = parsed.hostname;
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

async function fetchWithTimeout(fetchFn, url, init, timeoutMs) {
  const ctrl = typeof AbortController === "function" ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    return await fetchFn(url, { ...init, signal: ctrl ? ctrl.signal : undefined });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function fetchPinnedUrl(rawUrl, init = {}) {
  const parsed = new URL(rawUrl);
  const pinned = init.pinnedAddress;
  if (!pinned || typeof pinned.address !== "string" || (pinned.family !== 4 && pinned.family !== 6)) {
    return Promise.reject(new Error("missing_pinned_address"));
  }
  const transport = parsed.protocol === "https:" ? https : http;
  const headers = { ...(init.headers || {}), host: parsed.host };
  return new Promise((resolve, reject) => {
    let deadline = null;
    const clearDeadline = () => {
      if (!deadline) return;
      clearTimeout(deadline);
      deadline = null;
    };
    const request = transport.request({
      protocol: parsed.protocol,
      hostname: pinned.address,
      family: pinned.family,
      port: parsed.port || undefined,
      path: parsed.pathname + parsed.search,
      method: "GET",
      headers,
      servername: parsed.protocol === "https:" ? parsed.hostname : undefined,
    }, (incoming) => {
      incoming.once("end", clearDeadline);
      incoming.once("close", clearDeadline);
      const status = incoming.statusCode || 500;
      const hasNoBody = status === 204 || status === 205 || status === 304;
      resolve(new Response(hasNoBody ? null : Readable.toWeb(incoming), {
        status,
        statusText: incoming.statusMessage || "",
        headers: incoming.headers,
      }));
    });
    deadline = setTimeout(() => request.destroy(new Error("fetch_timeout")), FETCH_TIMEOUT_MS);
    request.once("error", (err) => {
      clearDeadline();
      reject(err);
    });
    const signal = init.signal;
    if (signal && signal.aborted) {
      request.destroy(new Error("fetch_aborted"));
      return;
    }
    if (signal && typeof signal.addEventListener === "function") {
      signal.addEventListener("abort", () => request.destroy(new Error("fetch_aborted")), { once: true });
    }
    request.end();
  });
}

async function cancelResponseBody(response) {
  if (!response || !response.body || typeof response.body.cancel !== "function") return;
  try {
    await response.body.cancel();
  } catch (err) {
    void err;
  }
}

async function readCapped(response, limit) {
  const reader = response.body && typeof response.body.getReader === "function"
    ? response.body.getReader() : null;
  if (!reader) {
    const text = await response.text();
    return text.length > limit ? text.slice(0, limit) : text;
  }
  const chunks = [];
  let total = 0;
  while (total < limit) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
    if (total >= limit) {
      try { await reader.cancel(); } catch (err) {
        // Cancel after we already have what we need — connection close noise
        // is expected. Swallowing silently here is safe per the read-limit
        // contract; the data we needed is already in `chunks`.
        void err;
      }
      break;
    }
  }
  const buf = Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength)));
  return new TextDecoder("utf-8", { fatal: false }).decode(buf.subarray(0, limit));
}

async function readCappedBytes(response, limit) {
  const reader = response.body && typeof response.body.getReader === "function"
    ? response.body.getReader() : null;
  if (!reader) {
    const ab = await response.arrayBuffer();
    return ab.byteLength > limit ? Buffer.from(ab, 0, limit) : Buffer.from(ab);
  }
  const chunks = [];
  let total = 0;
  while (total < limit) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
    if (total >= limit) {
      try { await reader.cancel(); } catch (err) {
        void err;
      }
      break;
    }
  }
  const buf = Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength)));
  return buf.subarray(0, limit);
}

const META_TAG_RX = /<meta\b[^>]*>/gi;
const ATTR_RX = /([a-zA-Z:-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g;
const TITLE_RX = /<title[^>]*>([\s\S]*?)<\/title>/i;
const LINK_CANONICAL_RX = /<link\b[^>]*rel\s*=\s*["']?canonical["']?[^>]*>/i;

function parseOpenGraph(html) {
  const meta = { title: "", description: "", image: "", siteName: "", canonicalUrl: "" };
  if (!html) return meta;
  const headEnd = html.search(/<\/head\b/i);
  const head = headEnd >= 0 ? html.slice(0, headEnd) : html;

  const ogTitle = readMeta(head, ["og:title", "twitter:title"]);
  const ogDesc = readMeta(head, ["og:description", "twitter:description", "description"]);
  const ogImage = readMeta(head, ["og:image", "twitter:image", "twitter:image:src"]);
  const ogSite = readMeta(head, ["og:site_name", "application-name"]);

  if (ogTitle) meta.title = sanitizeText(decodeEntities(ogTitle));
  if (ogDesc) meta.description = sanitizeText(decodeEntities(ogDesc));
  if (ogImage) meta.image = decodeEntities(ogImage);
  if (ogSite) meta.siteName = sanitizeText(decodeEntities(ogSite));

  if (!meta.title) {
    const m = TITLE_RX.exec(head);
    if (m) meta.title = sanitizeText(decodeEntities(m[1].trim()));
  }

  const canonical = LINK_CANONICAL_RX.exec(head);
  if (canonical) {
    const href = readAttr(canonical[0], "href");
    if (href) meta.canonicalUrl = decodeEntities(href);
  }
  return meta;
}

function readMeta(html, names) {
  META_TAG_RX.lastIndex = 0;
  let match;
  while ((match = META_TAG_RX.exec(html)) !== null) {
    const tag = match[0];
    const attrs = readAttrs(tag);
    const key = (attrs.property || attrs.name || "").toLowerCase();
    if (!key) continue;
    if (!names.includes(key)) continue;
    if (attrs.content) return attrs.content;
  }
  return "";
}

function readAttr(tag, name) {
  const attrs = readAttrs(tag);
  return attrs[name.toLowerCase()] || "";
}

function readAttrs(tag) {
  const out = {};
  ATTR_RX.lastIndex = 0;
  let m;
  while ((m = ATTR_RX.exec(tag)) !== null) {
    const key = m[1].toLowerCase();
    const val = m[3] != null ? m[3] : (m[4] != null ? m[4] : (m[5] != null ? m[5] : ""));
    out[key] = val;
  }
  return out;
}

const ENTITY_MAP = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'", nbsp: " " };

function decodeEntities(text) {
  if (typeof text !== "string") return "";
  return text.replace(/&(#\d+|#x[0-9a-fA-F]+|[a-zA-Z]+);/g, (_match, ent) => {
    if (ent.startsWith("#x") || ent.startsWith("#X")) {
      const code = Number.parseInt(ent.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _match;
    }
    if (ent.startsWith("#")) {
      const code = Number.parseInt(ent.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _match;
    }
    const lower = ent.toLowerCase();
    return ENTITY_MAP[lower] != null ? ENTITY_MAP[lower] : _match;
  });
}

/**
 * Strip HTML tags from a user-visible text field and cap length. Closes
 * SECURITY_AUDIT MED-16: even though the Rez renderer is text-only today,
 * the renderer surface is large enough that a future innerHTML reintroduction
 * would silently re-open this. Stripping at the storage boundary is the
 * defence-in-depth that survives renderer drift.
 */
function sanitizeText(text) {
  if (typeof text !== "string") return "";
  // Drop everything that looks like a tag — both opening and closing forms,
  // including malformed `<x` (no closing `>`) that an HTML parser would
  // treat as a tag. We don't need spec-perfect HTML parsing, just to deny
  // any sequence that a browser could interpret as markup.
  const stripped = text
    .replace(/<[^>]*>/g, "")                       // well-formed tags
    .replace(/<[^<]*$/g, "")                       // unterminated trailing tag-start
    .replace(/[\u0000-\u001F\u007F]/g, "");      // control chars
  const trimmed = stripped.trim();
  return trimmed.length > TEXT_FIELD_MAX_LEN
    ? trimmed.slice(0, TEXT_FIELD_MAX_LEN)
    : trimmed;
}

function absolutize(maybeUrl, base) {
  if (!maybeUrl) return "";
  try {
    return new URL(maybeUrl, base).toString();
  } catch {
    return "";
  }
}

function shortError(err) {
  if (!err) return "fetch_error";
  if (err.name === "AbortError") return "timeout";
  const msg = err.message ? String(err.message) : String(err);
  return msg.length > 120 ? msg.slice(0, 120) : msg;
}
