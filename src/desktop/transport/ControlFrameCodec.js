/**
 * Binary-safe value codec for the desktop control channel (Tauri sidecar).
 *
 * Electron IPC moved Uint8Array params/results via structured clone; the
 * control channel is JSON-over-WebSocket, so byte arrays are tagged and
 * base64-encoded in transit:
 *
 *   new Uint8Array([1,2])  <->  { "$rezU8": "AQI=" }
 *
 * Both sides of the channel import this module — the sidecar's
 * DesktopControlUplink (Node) and the webview's rezDesktop shim (browser) —
 * so it must stay runtime-neutral: Buffer when available, atob/btoa
 * otherwise. Plain objects and arrays are walked deeply; everything else
 * passes through untouched. Values are assumed acyclic (the same constraint
 * structured clone imposed on the Electron path).
 *
 * The tag key is reserved: a plain object that already carries "$rezU8"
 * would be mis-decoded, so encode() rejects it loudly instead of corrupting
 * data silently.
 */

const BYTES_TAG = "$rezU8";

const HAS_BUFFER = typeof globalThis.Buffer === "function"
  && typeof globalThis.Buffer.from === "function";

function bytesToBase64(bytes) {
  if (HAS_BUFFER) {
    return globalThis.Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
  }
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return globalThis.btoa(binary);
}

function base64ToBytes(b64) {
  if (HAS_BUFFER) {
    return new Uint8Array(globalThis.Buffer.from(b64, "base64"));
  }
  const binary = globalThis.atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Deep-encode a value for JSON transport: every Uint8Array (including
 * Buffer) becomes a tagged base64 object.
 */
export function encodeControlValue(value) {
  if (value instanceof Uint8Array) {
    return { [BYTES_TAG]: bytesToBase64(value) };
  }
  if (Array.isArray(value)) {
    return value.map((item) => encodeControlValue(item));
  }
  if (isPlainObject(value)) {
    if (Object.prototype.hasOwnProperty.call(value, BYTES_TAG)) {
      throw new Error("ControlFrameCodec: object uses reserved key " + BYTES_TAG);
    }
    const out = {};
    for (const key of Object.keys(value)) {
      out[key] = encodeControlValue(value[key]);
    }
    return out;
  }
  return value;
}

/**
 * Deep-decode the wire shape back: tagged base64 objects become Uint8Array.
 */
export function decodeControlValue(value) {
  if (Array.isArray(value)) {
    return value.map((item) => decodeControlValue(item));
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === BYTES_TAG && typeof value[BYTES_TAG] === "string") {
      return base64ToBytes(value[BYTES_TAG]);
    }
    const out = {};
    for (const key of keys) {
      out[key] = decodeControlValue(value[key]);
    }
    return out;
  }
  return value;
}
