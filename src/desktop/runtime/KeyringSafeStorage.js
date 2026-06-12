import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const CIPHERTEXT_PREFIX = Buffer.from("rezk1:", "utf8");
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

export class DeviceUnlockResetRequiredError extends Error {
  constructor(message) {
    super(message);
    this.name = "DeviceUnlockResetRequiredError";
    this.code = "DEVICE_UNLOCK_RESET_REQUIRED";
  }
}

/**
 * Electron-safeStorage replacement for the Tauri sidecar.
 *
 * Implements the same duck-type DesktopVaultService consumes —
 * `isEncryptionAvailable()`, `encryptString(plain) -> Buffer`,
 * `decryptString(Buffer) -> string` (both synchronous) — backed by a
 * 32-byte device key held in the OS keychain by the RUST shell (keyring
 * crate, service com.rezprotocol.chat). AES-256-GCM runs locally in the
 * sidecar; the key never touches the webview. Architecturally identical to
 * what Electron's safeStorage actually is (keychain-stored key + in-process
 * AES).
 *
 * Availability vs. materialization are deliberately separate:
 *   - At boot, UserEnvironment probes the keychain backend WITHOUT touching
 *     the device key (no OS "allow access" prompt). The result is passed in
 *     as `available` and drives `isEncryptionAvailable()` — i.e. whether the
 *     UI should even offer "remember on this device".
 *   - The device key itself is fetched LAZILY via `ensureDeviceKey()` the
 *     first time the user actually opts into device unlock. That host call is
 *     the ONLY point that may surface a keychain prompt, so users who never
 *     enable device unlock are never prompted.
 *
 * Ciphertexts are tagged `rezk1:` + iv(12) + tag(16) + ciphertext. Blobs
 * WITHOUT the tag are legacy Electron-safeStorage ciphertexts (Chromium
 * keychain-keyed) that this process can never decrypt — those throw
 * DEVICE_UNLOCK_RESET_REQUIRED so the caller clears device-unlock enrollment
 * and falls back to password unlock. Vault data itself is unaffected (it is
 * password/scrypt-encrypted); only the device-unlock convenience re-enrolls.
 */
export class KeyringSafeStorage {
  #key;
  #available;
  #hostChannel;

  constructor({ deviceKey = null, available = null, hostChannel = null } = {}) {
    if (deviceKey !== null) {
      if (!(deviceKey instanceof Uint8Array) || deviceKey.length !== 32) {
        throw new Error("KeyringSafeStorage requires a 32-byte deviceKey (or null)");
      }
      this.#key = Buffer.from(deviceKey);
    } else {
      this.#key = null;
    }
    // When `available` is not given, fall back to "a key is already present"
    // — preserves the old constructor contract for direct callers/tests that
    // hand in a deviceKey.
    this.#available = available === null ? (this.#key !== null) : available === true;
    this.#hostChannel = hostChannel && typeof hostChannel.request === "function" ? hostChannel : null;
  }

  /**
   * Build the adapter from a boot-time keychain availability probe. Does NOT
   * fetch the device key — that is deferred to ensureDeviceKey() so the OS
   * keychain prompt only fires when the user opts into device unlock.
   *
   * `available` comes from UserEnvironment (keychain.probe). When false (e.g.
   * a Linux box with no Secret Service), the vault behaves exactly like
   * Electron without safeStorage: password unlock only, no device-unlock
   * offer — instead of refusing to boot.
   */
  static async create({ hostChannel, available = false } = {}) {
    if (!hostChannel || typeof hostChannel.request !== "function") {
      throw new Error("KeyringSafeStorage.create requires hostChannel");
    }
    return new KeyringSafeStorage({
      deviceKey: null,
      available: available === true,
      hostChannel,
    });
  }

  isEncryptionAvailable() {
    return this.#available;
  }

  /**
   * Lazily fetch and cache the 32-byte device key from the host keychain.
   * This is the ONLY call that touches the OS keychain (and may surface a
   * permission prompt) — callers invoke it right before encrypt/decrypt on
   * the device-unlock opt-in path. No-op once the key is cached. Throws if
   * the keychain is unavailable or the host can't produce a valid key.
   */
  async ensureDeviceKey() {
    if (this.#key !== null) return;
    if (!this.#available) {
      throw new Error("KeyringSafeStorage: keychain unavailable");
    }
    if (!this.#hostChannel) {
      throw new Error("KeyringSafeStorage: no host channel to fetch device key");
    }
    const result = await this.#hostChannel.request("keychain.getOrCreateDeviceKey", {});
    const keyB64 = result && typeof result.keyB64 === "string" ? result.keyB64 : "";
    const key = Buffer.from(keyB64, "base64");
    if (key.length !== 32) {
      throw new Error("host returned a malformed device key");
    }
    this.#key = key;
  }

  encryptString(plainText) {
    if (this.#key === null) {
      const err = new Error("KeyringSafeStorage: encryption unavailable (no device key)");
      err.code = "DEVICE_KEY_UNAVAILABLE";
      throw err;
    }
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(String(plainText == null ? "" : plainText), "utf8"),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([CIPHERTEXT_PREFIX, iv, tag, ciphertext]);
  }

  decryptString(wrapped) {
    if (this.#key === null) {
      const err = new Error("KeyringSafeStorage: decryption unavailable (no device key)");
      err.code = "DEVICE_KEY_UNAVAILABLE";
      throw err;
    }
    const buffer = Buffer.isBuffer(wrapped) ? wrapped : Buffer.from(wrapped || []);
    if (
      buffer.length < CIPHERTEXT_PREFIX.length + IV_LENGTH + TAG_LENGTH
      || !buffer.subarray(0, CIPHERTEXT_PREFIX.length).equals(CIPHERTEXT_PREFIX)
    ) {
      throw new DeviceUnlockResetRequiredError(
        "Stored device-unlock data was created by the previous (Electron) version "
        + "and cannot be migrated. Re-enable device unlock in Settings.",
      );
    }
    const ivStart = CIPHERTEXT_PREFIX.length;
    const tagStart = ivStart + IV_LENGTH;
    const dataStart = tagStart + TAG_LENGTH;
    const iv = buffer.subarray(ivStart, tagStart);
    const tag = buffer.subarray(tagStart, dataStart);
    const ciphertext = buffer.subarray(dataStart);
    const decipher = createDecipheriv("aes-256-gcm", this.#key, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plain.toString("utf8");
  }
}
