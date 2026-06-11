import { scrypt } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt);

/**
 * Registers the desktop crypto primitive channels. Ported verbatim from the
 * inline handlers in electron/main.mjs so the Node sidecar serves the exact
 * same surface over the control uplink. Unlike the vault/runtime handlers
 * (which return `{ok, result|error}` envelopes), these return RAW values and
 * signal failure by throwing — matching Electron's ipcMain.handle semantics
 * that preload.cjs exposed un-unwrapped.
 *
 * `ipcMain` is any registry with `handle(channel, handler)` —
 * Electron's ipcMain or DesktopControlUplink.ipcRegistry.
 * `crypto` is a NodeCryptoProvider (or compatible) instance.
 */
export function registerDesktopCryptoChannels({ ipcMain, crypto } = {}) {
  if (!ipcMain || typeof ipcMain.handle !== "function") {
    throw new Error("registerDesktopCryptoChannels requires ipcMain");
  }
  if (!crypto) throw new Error("registerDesktopCryptoChannels requires crypto provider");

  ipcMain.handle("desktop:generateSigningKeyPair", () => {
    const { publicKey, privateKey } = crypto.generateSigningKeyPair();
    return { publicKey, privateKey };
  });

  ipcMain.handle("desktop:sign", (_event, options = {}) => crypto.sign(options));
  ipcMain.handle("desktop:verify", (_event, options = {}) => crypto.verify(options));
  ipcMain.handle("desktop:dhGenerateKeyPair", (_event, options = {}) => crypto.dhGenerateKeyPair(options));
  ipcMain.handle("desktop:dhDerive", (_event, options = {}) => crypto.dhDerive(options));

  /**
   * Native scrypt key derivation — memory-hard, GPU/ASIC resistant.
   * Parameters match Node.js crypto.scrypt options:
   *   password {string}, salt {Uint8Array}, N {number}, r {number}, p {number}, keyLen {number}
   * maxmem is computed as 2x the theoretical requirement (128 * N * r) to
   * leave headroom. At N=2^17, r=8: requirement = 128 MiB -> maxmem = 256 MiB.
   */
  ipcMain.handle("desktop:scrypt", async (_event, opts = {}) => {
    const password = String(opts.password || "");
    if (!password) throw new Error("desktop:scrypt: password required");

    const salt = opts.salt instanceof Uint8Array ? opts.salt : Buffer.from(Object.values(opts.salt || {}));
    if (!salt || salt.length < 16) throw new Error("desktop:scrypt: salt must be >= 16 bytes");

    const N = Number(opts.N);
    const r = Number(opts.r);
    const p = Number(opts.p);
    const keyLen = Number(opts.keyLen);

    if (!Number.isInteger(N) || N < 1024 || N > 1_048_576 || (N & (N - 1)) !== 0) {
      throw new Error(`desktop:scrypt: invalid N (${N}), must be power-of-two >= 1024 and <= 2^20`);
    }
    if (!Number.isInteger(r) || r < 1) throw new Error(`desktop:scrypt: invalid r (${r})`);
    if (!Number.isInteger(p) || p < 1) throw new Error(`desktop:scrypt: invalid p (${p})`);
    if (!Number.isInteger(keyLen) || keyLen < 16 || keyLen > 64) {
      throw new Error(`desktop:scrypt: invalid keyLen (${keyLen})`);
    }

    const maxmem = 2 * 128 * N * r;

    const keyBuffer = await scryptAsync(password, Buffer.from(salt), keyLen, { N, r, p, maxmem });
    return new Uint8Array(keyBuffer);
  });
}
