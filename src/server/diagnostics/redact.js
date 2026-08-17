/**
 * Redaction for diagnostic bundles.
 *
 * A diagnostic bundle is written to the user's own disk and never transmitted
 * (see docs/DIAGNOSTICS.md). But a tester will attach it to a PUBLIC issue, so
 * it must be safe to publish. That is the bar every rule here is written to:
 * assume the contents end up on the internet under the user's name.
 *
 * Posture: DENY BY DEFAULT. Bundles carry counts, versions, error shapes and
 * timing. They never carry message text, invite codes, keys, file names, or
 * full identifiers. Where an identifier genuinely helps correlate a report to a
 * log, it is truncated to a short prefix — enough to line up two events, far
 * too little to identify an account.
 *
 * These functions are pure so they are testable in isolation, and they are the
 * single place redaction happens: callers must not hand-roll their own.
 */

// rez identifiers. Kept as a visible-prefix + marker so a reader can still tell
// two events involve the SAME account without learning which account.
const REZ_ID = /\b(rez:(?:acct|dev|relay|node):)([A-Za-z0-9_-]{6,})/g;
// Inbox / thread / group / message / peer-link / invite handles.
const PREFIXED_ID = /\b((?:inbox|thread|grp|msg|plink|plinv|recinv|plinvite):)([A-Za-z0-9_-]{6,})/g;
// Invite codes carry X3DH material — never emit any part of one.
const INVITE_CODE = /\brez:invite:[A-Za-z0-9_+/=:-]+/g;
// Link codes from the device-link ceremony (a live PSK while the window is open).
const LINK_CODE = /\brez:link:[A-Za-z0-9_+/=:-]+/g;
// Anything that looks like bulk base64 (keys, ciphertext, envelopes, sigs).
const LONG_B64 = /\b[A-Za-z0-9+/]{40,}={0,2}\b/g;
// Bare hex runs (device ids, hashes, key ids) not already covered above.
const LONG_HEX = /\b[0-9a-f]{32,}\b/g;
// Absolute filesystem paths leak the OS username.
const UNIX_PATH = /(?:\/(?:Users|home)\/)[^/\s"']+/g;
const WINDOWS_PATH = /([A-Za-z]:\\Users\\)[^\\\s"']+/g;

const ID_PREFIX_KEEP = 4;

/**
 * Redact a single string. Order matters: the most specific/most dangerous
 * patterns run first so a broader rule cannot partially rewrite them into
 * something that then escapes.
 */
export function redactText(value) {
  if (typeof value !== "string" || value.length === 0) return value;
  let out = value;
  out = out.replace(INVITE_CODE, "rez:invite:<redacted>");
  out = out.replace(LINK_CODE, "rez:link:<redacted>");
  out = out.replace(REZ_ID, (_m, prefix, body) => prefix + body.slice(0, ID_PREFIX_KEEP) + "…<redacted>");
  out = out.replace(PREFIXED_ID, (_m, prefix, body) => prefix + body.slice(0, ID_PREFIX_KEEP) + "…<redacted>");
  out = out.replace(UNIX_PATH, "<home>");
  out = out.replace(WINDOWS_PATH, "$1<user>");
  out = out.replace(LONG_B64, "<redacted-b64>");
  out = out.replace(LONG_HEX, "<redacted-hex>");
  return out;
}

// Keys whose VALUE is content or secret material regardless of how it looks.
// Matched case-insensitively against the whole key name.
const DENY_KEYS = new Set([
  "text", "body", "message", "content", "plaintext", "payload", "preview",
  "ciphertext", "inner", "innerbytes", "bytes", "buffer",
  "password", "passphrase", "secret", "token", "key", "privatekey",
  "privatekeyb64", "seed", "mnemonic", "psk", "sig", "signature", "signatureb64",
  "invitecode", "linkcode", "filename", "displayname", "label", "avatar",
]);

function isDeniedKey(key) {
  return DENY_KEYS.has(String(key).toLowerCase());
}

/**
 * Deep-redact a JSON-ish value for inclusion in a bundle.
 *
 * - denied keys are dropped entirely (not emptied — an empty string still
 *   confirms the field existed and had a value)
 * - strings run through redactText
 * - numbers/booleans/null pass through
 * - functions, symbols and anything else become "<dropped:type>" rather than
 *   being silently omitted, so a reader can see something was there
 *
 * `maxDepth` bounds recursion so a cyclic or pathological object cannot hang
 * bundle export; beyond it the subtree is replaced with a marker.
 */
export function redactValue(value, { maxDepth = 6, _depth = 0, _seen = null } = {}) {
  const seen = _seen || new WeakSet();
  if (value === null) return null;
  const t = typeof value;
  if (t === "string") return redactText(value);
  if (t === "number" || t === "boolean") return value;
  if (t === "bigint") return String(value);
  if (t === "undefined") return undefined;
  if (t !== "object") return "<dropped:" + t + ">";

  if (seen.has(value)) return "<cycle>";
  if (_depth >= maxDepth) return "<max-depth>";
  seen.add(value);

  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    return "<binary:" + (value.byteLength || 0) + "b>";
  }
  if (Array.isArray(value)) {
    return value.map((v) => redactValue(v, { maxDepth, _depth: _depth + 1, _seen: seen }));
  }
  if (value instanceof Error) {
    return {
      name: String(value.name || "Error"),
      message: redactText(String(value.message || "")),
      code: value.code == null ? null : redactText(String(value.code)),
      stack: redactStack(value.stack),
    };
  }
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (isDeniedKey(k)) continue;
    const red = redactValue(v, { maxDepth, _depth: _depth + 1, _seen: seen });
    if (red !== undefined) out[k] = red;
  }
  return out;
}

/**
 * Redact a stack trace. Frames keep function names and the file basename with
 * line/column — enough to locate the code — but absolute paths are stripped,
 * since they carry the OS username and local directory layout.
 */
export function redactStack(stack) {
  if (typeof stack !== "string" || stack.length === 0) return null;
  return stack
    .split("\n")
    .slice(0, 40)
    .map((line) => {
      const noPath = line.replace(/\(?(?:file:\/\/)?(\/[^\s)]+|[A-Za-z]:\\[^\s)]+)\)?/g, (match) => {
        const cleaned = match.replace(/^\(|\)$/g, "");
        const parts = cleaned.split(/[/\\]/);
        const tail = parts[parts.length - 1] || cleaned;
        return "(" + tail + ")";
      });
      return redactText(noPath);
    })
    .join("\n");
}
