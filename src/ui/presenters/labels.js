// Pure formatters for view-layer rendering. No store reads here — anything
// that needs to consult Session/Contact/Thread/Group goes through
// `src/ui/queries/` instead.

const FALLBACK_LEN = 12;

export function shortId(id, len = FALLBACK_LEN) {
  const value = String(id || "").trim();
  if (!value) return "";
  return value.length > len ? value.slice(0, len) : value;
}

export function ellipsisId(value, max = 16) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (text.length <= max) return text;
  const head = Math.max(4, Math.floor((max - 1) / 2));
  const tail = Math.max(4, max - head - 1);
  return text.slice(0, head) + "…" + text.slice(-tail);
}

export function avatarInitials(str, max = 2) {
  const value = String(str || "").trim();
  if (!value) return "?";
  const parts = value.split(/[\s_-]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase().slice(0, max);
  return value.slice(0, max).toUpperCase();
}

export function avatarHue(str) {
  let value = 0;
  const input = String(str || "");
  for (let i = 0; i < input.length; i++) value = (value * 31 + input.charCodeAt(i)) >>> 0;
  return value % 360;
}
