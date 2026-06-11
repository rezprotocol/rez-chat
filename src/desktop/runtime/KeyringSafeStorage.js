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
 * crate, service com.rezprotocol.chat). The key is fetched ONCE at sidecar
 * boot over the stdio HostChannel and never touches the webview; AES-256-GCM
 * runs locally in the sidecar. Architecturally identical to what Electron's
 * safeStorage actually is (keychain-stored key + in-process AES).
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

  constructor({ deviceKey = null } = {}) {
    if (deviceKey !== null) {
      if (!(deviceKey instanceof Uint8Array) || deviceKey.length !== 32) {
        throw new Error("KeyringSafeStorage requires a 32-byte deviceKey (or null)");
      }
      this.#key = Buffer.from(deviceKey);
    } else {
      this.#key = null;
    }
  }

  /**
   * Fetch the device key from the host (Rust keychain bridge) and build the
   * adapter. Keychain failure degrades to an unavailable adapter — the vault
   * then behaves exactly like Electron without safeStorage (password unlock
   * only), instead of refusing to boot.
   */
  static async create({ hostChannel, logger = console } = {}) {
    if (!hostChannel || typeof hostChannel.request !== "function") {
      throw new Error("KeyringSafeStorage.create requires hostChannel");
    }
    try {
      const result = await hostChannel.request("keychain.getOrCreateDeviceKey", {});
      const keyB64 = result && typeof result.keyB64 === "string" ? result.keyB64 : "";
      const key = Buffer.from(keyB64, "base64");
      if (key.length !== 32) {
        throw new Error("host returned a malformed device key");
      }
      return new KeyringSafeStorage({ deviceKey: key });
    } catch (err) {
      if (logger && typeof logger.warn === "function") {
        logger.warn(
          "[keyring-safe-storage] device key unavailable — device unlock disabled:",
          err && err.message ? err.message : err,
        );
      }
      return new KeyringSafeStorage({ deviceKey: null });
    }
  }

  isEncryptionAvailable() {
    return this.#key !== null;
  }

  encryptString(plainText) {
    if (this.#key === null) {
      throw new Error("KeyringSafeStorage: encryption unavailable (no device key)");
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
      throw new Error("KeyringSafeStorage: decryption unavailable (no device key)");
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
