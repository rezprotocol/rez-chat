export function nonEmptyString(value) {
  const text = String(value || "").trim();
  return text || "";
}

export function toFiniteNumber(value, fallback = 0) {
  const next = Number(value);
  return Number.isFinite(next) ? next : fallback;
}

export function uniqueStrings(values = []) {
  const list = Array.isArray(values) ? values : [];
  const seen = new Set();
  const out = [];
  for (const value of list) {
    const text = nonEmptyString(value);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

/**
 * Construct a record from untrusted input at a trust boundary (KV
 * deserialization, UI bus payload). If construction succeeds, returns the
 * record. If it throws, logs and returns null.
 *
 * Optional `seed` fills in defaults BEFORE construction — typically used to
 * inject the caller's clock value (`{ createdAtMs: nowMs }`) so test clocks
 * stay deterministic. Existing fields on `input` always win over `seed`.
 *
 * @param {Function} RecordClass    A record class (RRecord subclass).
 * @param {*} input                 Raw input (object, null, undefined, etc.).
 * @param {object} [opts]
 * @param {object} [opts.seed]      Field defaults applied only when missing.
 * @param {string} [opts.label]     Source label for log messages.
 */
export function coerceRow(RecordClass, input, { seed = null, label = "" } = {}) {
  if (!input || typeof input !== "object") return null;
  const merged = seed
    ? { ...seed, ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) }
    : input;
  try {
    return new RecordClass(merged);
  } catch (err) {
    const tag = label ? `[${label}] ` : "";
    console.error(`${tag}malformed ${RecordClass.name} row dropped:`, err && err.message ? err.message : err);
    return null;
  }
}
