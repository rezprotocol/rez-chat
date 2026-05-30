// URL detection used by both message rendering and unfurl triggering.
//
// Conservative on purpose: http(s) only, must have a scheme. We don't try to
// "smarten up" bare hostnames (e.g. "github.com" without scheme) — those are
// frequently false positives in chat text. Tagged with a non-capturing group
// so the global regex stays cheap to reset between scans.
const URL_RX = /\bhttps?:\/\/[^\s<>"'()\[\]{}]+/gi;

// Trailing punctuation that's almost always sentence noise, not part of the URL.
const TRAILING_NOISE = /[).,;:!?—–'"“”]+$/;

function tidyUrl(raw) {
  let out = String(raw);
  // Balance parentheses — Wikipedia-style "...(foo_(bar))" needs the trailing
  // paren kept; "see (https://x.com/y)." needs it stripped.
  while (out.endsWith(")")) {
    const opens = (out.match(/\(/g) || []).length;
    const closes = (out.match(/\)/g) || []).length;
    if (closes > opens) {
      out = out.slice(0, -1);
      continue;
    }
    break;
  }
  out = out.replace(TRAILING_NOISE, "");
  return out;
}

/**
 * Walk `text` and return an ordered list of segments:
 *   { type: "text", value }   plain prose
 *   { type: "url", url, label }   detected http(s) URL
 *
 * The renderer maps `url` segments to `<a>` elements and `text` segments to
 * Text nodes. `extractUrls()` returns just the URL strings (for unfurl).
 */
export function tokenizeText(text) {
  const out = [];
  const src = String(text == null ? "" : text);
  if (!src) return out;
  URL_RX.lastIndex = 0;
  let cursor = 0;
  let match;
  while ((match = URL_RX.exec(src)) !== null) {
    const start = match.index;
    if (start > cursor) {
      out.push({ type: "text", value: src.slice(cursor, start) });
    }
    const raw = match[0];
    const url = tidyUrl(raw);
    if (!url) {
      // tidy stripped the whole thing (unlikely) — fall through as text.
      out.push({ type: "text", value: raw });
    } else {
      out.push({ type: "url", url, label: url });
      // If tidy trimmed trailing chars, those belong in the next text segment.
      const trimmed = raw.length - url.length;
      if (trimmed > 0) {
        out.push({ type: "text", value: raw.slice(url.length) });
      }
    }
    cursor = start + raw.length;
  }
  if (cursor < src.length) {
    out.push({ type: "text", value: src.slice(cursor) });
  }
  return out;
}

export function extractUrls(text) {
  return tokenizeText(text).filter((s) => s.type === "url").map((s) => s.url);
}
