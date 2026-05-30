import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { scrypt as nodeScrypt } from "node:crypto";
import Database from "better-sqlite3";
import {
  createKeystoreAccount,
  unlockKeystoreAccount,
  createKeystoreEnvelope,
  getDefaultKdfParams,
  deriveUnlockKey,
  encryptKeystore,
  decryptKeystore,
  randomBytes,
  toBase64,
  fromBase64,
} from "@rezprotocol/sdk/client";

const scryptAsync = promisify(nodeScrypt);

class MemoryKeystoreStore {
  constructor(envelope = null) {
    this.envelope = envelope;
  }

  async hasKeystore() {
    return this.envelope != null;
  }

  async getKeystoreEnvelope() {
    return this.envelope;
  }

  async putKeystoreEnvelope(envelope) {
    this.envelope = envelope;
    return envelope;
  }
}

function normalizeString(value) {
  return String(value == null ? "" : value).trim();
}

function cloneJson(value) {
  if (value == null) return null;
  return JSON.parse(JSON.stringify(value));
}

function createDesktopCryptoProvider() {
  const cryptoObj = globalThis.crypto;
  if (!cryptoObj || !cryptoObj.subtle || typeof cryptoObj.getRandomValues !== "function") {
    throw new Error("DesktopVaultService requires WebCrypto");
  }
  return {
    crypto: cryptoObj,
    subtle: cryptoObj.subtle,
    getRandomValues: cryptoObj.getRandomValues.bind(cryptoObj),
    async scrypt({ password, salt, N, r, p, keyLen } = {}) {
      const result = await scryptAsync(String(password || ""), Buffer.from(salt), Number(keyLen), {
        N: Number(N),
        r: Number(r),
        p: Number(p),
        maxmem: 2 * 128 * Number(N) * Number(r),
      });
      return new Uint8Array(result);
    },
  };
}

function safeStorageAvailable(safeStorage) {
  return !!(
    safeStorage
    && typeof safeStorage.isEncryptionAvailable === "function"
    && safeStorage.isEncryptionAvailable()
    && typeof safeStorage.encryptString === "function"
    && typeof safeStorage.decryptString === "function"
  );
}

/**
 * Auto-relock defaults (SECURITY_AUDIT MED-17). After unlock, the vault
 * will lock itself when EITHER:
 *   - no `noteActivity` call arrives for IDLE_TIMEOUT_MS, OR
 *   - ABSOLUTE_TIMEOUT_MS has elapsed since the unlock (regardless of activity).
 *
 * The idle window covers walked-away-with-app-open scenarios; the absolute
 * window bounds blast radius even if some renderer-side activity keeps the
 * idle timer alive indefinitely. Override via DesktopVaultService options
 * (used by tests to exercise the timers without waiting minutes).
 */
const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60_000;       // 15 minutes
const DEFAULT_ABSOLUTE_TIMEOUT_MS = 4 * 60 * 60_000; // 4 hours

function bufferToBase64(value) {
  if (Buffer.isBuffer(value)) return value.toString("base64");
  if (value instanceof Uint8Array) return Buffer.from(value).toString("base64");
  return Buffer.from(String(value || ""), "utf8").toString("base64");
}

function base64ToBuffer(value) {
  return Buffer.from(String(value || ""), "base64");
}

export class DesktopVaultService {
  #dbPath;
  #safeStorage;
  #cryptoProvider;
  #clock;
  #db;
  #activeAccount;
  #idleTimeoutMs;
  #absoluteTimeoutMs;
  #idleTimer;
  #absoluteTimer;
  #unlockedAtMs;
  #onAutoLock;

  constructor({
    dbPath,
    safeStorage = null,
    cryptoProvider = null,
    clock = () => Date.now(),
    database = null,
    idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
    absoluteTimeoutMs = DEFAULT_ABSOLUTE_TIMEOUT_MS,
    onAutoLock = null,
  } = {}) {
    const resolvedPath = normalizeString(dbPath);
    if (!resolvedPath && !database) {
      throw new Error("DesktopVaultService requires dbPath");
    }
    this.#dbPath = resolvedPath;
    this.#safeStorage = safeStorage;
    this.#cryptoProvider = cryptoProvider || createDesktopCryptoProvider();
    this.#clock = typeof clock === "function" ? clock : () => Date.now();
    this.#db = database;
    this.#activeAccount = null;
    this.#idleTimeoutMs = Number.isFinite(idleTimeoutMs) && idleTimeoutMs > 0
      ? idleTimeoutMs : DEFAULT_IDLE_TIMEOUT_MS;
    this.#absoluteTimeoutMs = Number.isFinite(absoluteTimeoutMs) && absoluteTimeoutMs > 0
      ? absoluteTimeoutMs : DEFAULT_ABSOLUTE_TIMEOUT_MS;
    this.#idleTimer = null;
    this.#absoluteTimer = null;
    this.#unlockedAtMs = 0;
    this.#onAutoLock = typeof onAutoLock === "function" ? onAutoLock : null;
  }

  open() {
    if (!this.#db) {
      fs.mkdirSync(path.dirname(this.#dbPath), { recursive: true });
      this.#db = new Database(this.#dbPath);
    }
    this.#migrate();
    return this;
  }

  close() {
    this.lock();
    const db = this.#db;
    this.#db = null;
    if (db && typeof db.close === "function") db.close();
  }

  status() {
    const accounts = this.listAccounts();
    return {
      hasAccounts: accounts.length > 0,
      locked: this.#activeAccount == null,
      activeAccountId: this.#activeAccount ? this.#activeAccount.accountId : null,
      osWrapAvailable: safeStorageAvailable(this.#safeStorage),
    };
  }

  listAccounts() {
    const db = this.#requireDb();
    const rows = db.prepare(`
      SELECT accountId, profileNameHint, safeWrappedPasswordB64, createdAtMs, updatedAtMs FROM vault_accounts
      ORDER BY updatedAtMs DESC, accountId ASC
    `).all();
    return rows.map((row) => ({
      id: row.accountId,
      label: row.profileNameHint || "Account",
      accountIdHint: row.accountId,
      deviceUnlockEnabled: typeof row.safeWrappedPasswordB64 === "string" && row.safeWrappedPasswordB64.length > 0,
      createdAtMs: Number(row.createdAtMs) || null,
      updatedAtMs: Number(row.updatedAtMs) || null,
    }));
  }

  async createAccount({ profileName = "", password = "" } = {}) {
    const name = normalizeString(profileName);
    const pwd = String(password || "");
    if (!name) throw new Error("vault.createAccount requires profileName");
    if (pwd.length < 8) throw new Error("vault.createAccount requires password length >= 8");
    const keystoreStore = new MemoryKeystoreStore();
    const created = await createKeystoreAccount({
      password: pwd,
      profileName: name,
      keystoreStore,
      cryptoProvider: this.#cryptoProvider,
    });
    const envelope = await keystoreStore.getKeystoreEnvelope();
    const appDataKeyBytes = randomBytes(32, this.#cryptoProvider);
    const appKeyEnvelope = await this.#encryptAppDataKey({ password: pwd, appDataKeyBytes });
    const safeWrappedAppKeyB64 = this.#safeWrapAppDataKey(appDataKeyBytes);
    const now = this.#clock();
    this.#requireDb().prepare(`
      INSERT INTO vault_accounts (
        accountId, profileNameHint, keystoreEnvelopeJson, appKeyEnvelopeJson, safeWrappedAppKeyB64, createdAtMs, updatedAtMs
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      created.accountId,
      name,
      JSON.stringify(envelope),
      JSON.stringify(appKeyEnvelope),
      safeWrappedAppKeyB64,
      now,
      now,
    );
    appDataKeyBytes.fill(0);
    return this.unlock({ accountId: created.accountId, password: pwd });
  }

  async unlock({ accountId = null, password = "", enableDeviceUnlock = false } = {}) {
    const pwd = String(password || "");
    if (!pwd) throw new Error("vault.unlock requires password");
    const row = this.#loadAccountRow(accountId);
    if (!row) throw new Error("No vault account found");
    const keystoreEnvelope = JSON.parse(row.keystoreEnvelopeJson);
    const keystoreStore = new MemoryKeystoreStore(keystoreEnvelope);
    const unlocked = await unlockKeystoreAccount({
      password: pwd,
      keystoreStore,
      cryptoProvider: this.#cryptoProvider,
    });
    const appKeyEnvelope = JSON.parse(row.appKeyEnvelopeJson);
    const appDataKeyBytes = await this.#decryptAppDataKey({
      password: pwd,
      appKeyEnvelope,
      safeWrappedAppKeyB64: row.safeWrappedAppKeyB64,
    });
    this.#clearActive();
    // profileNameHint is the authoritative current display name once the
    // user has set one via setProfileName. The keystore payload's
    // profileName is the creation-time seed and is only used when the hint
    // is missing or still the legacy literal "Account" placeholder.
    const hintName = normalizeString(row.profileNameHint);
    const seedName = normalizeString(unlocked.profileName);
    const resolvedName = hintName && hintName !== "Account" ? hintName : seedName;
    this.#activeAccount = {
      accountId: unlocked.accountId,
      deviceId: unlocked.deviceId,
      profileName: resolvedName,
      identityPublicKey: unlocked.identityPublicKey,
      identityKeyPair: cloneJson(unlocked.identityKeyPair),
      appDataKeyBytes,
    };
    // Heal legacy rows that stored the literal string "Account" as the hint
    // (pre-fix accounts). The unlocked keystore is the authoritative source
    // for the chosen profile name.
    if (seedName && seedName !== "Account") {
      this.#requireDb().prepare(`
        UPDATE vault_accounts SET profileNameHint = ?, updatedAtMs = ?
        WHERE accountId = ? AND profileNameHint = 'Account'
      `).run(seedName, this.#clock(), unlocked.accountId);
    }
    if (enableDeviceUnlock === true) {
      this.#writeWrappedPassword({ accountId: unlocked.accountId, password: pwd });
    }
    this.#startAutoLockTimers();
    return this.getActiveIdentitySummary();
  }

  /**
   * SECURITY_AUDIT MED-17: callers should invoke this on every renderer-
   * visible request that implies a live user. Resets the idle timer; does
   * NOT affect the absolute timer. Safe to call when the vault is locked
   * (no-op).
   */
  noteActivity() {
    if (!this.#activeAccount) return;
    this.#armIdleTimer();
  }

  async unlockWithDevice({ accountId = null } = {}) {
    if (!safeStorageAvailable(this.#safeStorage)) {
      throw new Error("Device unlock unavailable: OS encryption not available");
    }
    const row = this.#loadAccountRow(accountId);
    if (!row) throw new Error("No vault account found");
    const wrappedB64 = typeof row.safeWrappedPasswordB64 === "string" ? row.safeWrappedPasswordB64 : "";
    if (!wrappedB64) {
      throw new Error("Device unlock not enabled for this account");
    }
    const recoveredPassword = this.#safeStorage.decryptString(base64ToBuffer(wrappedB64));
    if (typeof recoveredPassword !== "string" || recoveredPassword.length === 0) {
      throw new Error("Device unlock failed: saved password could not be recovered");
    }
    return this.unlock({ accountId: row.accountId, password: recoveredPassword });
  }

  enableDeviceUnlock({ accountId = null, password = "" } = {}) {
    if (!safeStorageAvailable(this.#safeStorage)) {
      throw new Error("Device unlock unavailable: OS encryption not available");
    }
    const pwd = String(password || "");
    if (!pwd) throw new Error("enableDeviceUnlock requires password");
    const row = this.#loadAccountRow(accountId);
    if (!row) throw new Error("No vault account found");
    this.#writeWrappedPassword({ accountId: row.accountId, password: pwd });
    return { accountId: row.accountId, deviceUnlockEnabled: true };
  }

  disableDeviceUnlock({ accountId = null } = {}) {
    const row = this.#loadAccountRow(accountId);
    if (!row) throw new Error("No vault account found");
    this.#requireDb().prepare(`
      UPDATE vault_accounts SET safeWrappedPasswordB64 = NULL, updatedAtMs = ?
      WHERE accountId = ?
    `).run(this.#clock(), row.accountId);
    return { accountId: row.accountId, deviceUnlockEnabled: false };
  }

  setProfileName({ accountId = null, profileName = "" } = {}) {
    const name = normalizeString(profileName);
    if (!name) throw new Error("vault.setProfileName requires non-empty profileName");
    const row = this.#loadAccountRow(accountId);
    if (!row) throw new Error("No vault account found");
    this.#requireDb().prepare(`
      UPDATE vault_accounts SET profileNameHint = ?, updatedAtMs = ?
      WHERE accountId = ?
    `).run(name, this.#clock(), row.accountId);
    if (this.#activeAccount && this.#activeAccount.accountId === row.accountId) {
      this.#activeAccount.profileName = name;
    }
    return { accountId: row.accountId, profileName: name };
  }

  setAvatarFileHash({ accountId = null, avatarFileHash = "" } = {}) {
    const row = this.#loadAccountRow(accountId);
    if (!row) throw new Error("No vault account found");
    const hash = typeof avatarFileHash === "string" ? avatarFileHash : "";
    this.#requireDb().prepare(`
      UPDATE vault_accounts SET avatarFileHash = ?, updatedAtMs = ?
      WHERE accountId = ?
    `).run(hash || null, this.#clock(), row.accountId);
    return { accountId: row.accountId, avatarFileHash: hash };
  }

  getAvatarFileHash({ accountId = null } = {}) {
    const row = this.#loadAccountRow(accountId);
    if (!row) return { accountId: null, avatarFileHash: "" };
    return {
      accountId: row.accountId,
      avatarFileHash: typeof row.avatarFileHash === "string" ? row.avatarFileHash : "",
    };
  }

  setAvatarDataB64({ accountId = null, avatarDataB64 = "" } = {}) {
    const row = this.#loadAccountRow(accountId);
    if (!row) throw new Error("No vault account found");
    const data = typeof avatarDataB64 === "string" ? avatarDataB64 : "";
    this.#requireDb().prepare(`
      UPDATE vault_accounts SET avatarDataB64 = ?, updatedAtMs = ?
      WHERE accountId = ?
    `).run(data || null, this.#clock(), row.accountId);
    return { accountId: row.accountId, avatarDataB64: data };
  }

  getAvatarDataB64({ accountId = null } = {}) {
    const row = this.#loadAccountRow(accountId);
    if (!row) return { accountId: null, avatarDataB64: "" };
    return {
      accountId: row.accountId,
      avatarDataB64: typeof row.avatarDataB64 === "string" ? row.avatarDataB64 : "",
    };
  }

  #writeWrappedPassword({ accountId, password } = {}) {
    const wrapped = this.#safeStorage.encryptString(String(password || ""));
    const wrappedB64 = bufferToBase64(wrapped);
    this.#requireDb().prepare(`
      UPDATE vault_accounts SET safeWrappedPasswordB64 = ?, updatedAtMs = ?
      WHERE accountId = ?
    `).run(wrappedB64, this.#clock(), accountId);
  }

  lock() {
    this.#clearActive();
    return this.status();
  }

  getActiveIdentitySummary() {
    if (!this.#activeAccount) return null;
    return {
      accountId: this.#activeAccount.accountId,
      deviceId: this.#activeAccount.deviceId,
      profileName: this.#activeAccount.profileName || null,
      identityPublicKey: this.#activeAccount.identityPublicKey || null,
    };
  }

  getActiveIdentity() {
    if (!this.#activeAccount) return null;
    return {
      accountId: this.#activeAccount.accountId,
      deviceId: this.#activeAccount.deviceId,
      profileName: this.#activeAccount.profileName || null,
      identityPublicKey: this.#activeAccount.identityPublicKey || null,
      identityKeyPair: cloneJson(this.#activeAccount.identityKeyPair),
    };
  }

  getAppDataKeyBytes() {
    if (!this.#activeAccount || !(this.#activeAccount.appDataKeyBytes instanceof Uint8Array)) {
      throw new Error("Vault is locked");
    }
    return new Uint8Array(this.#activeAccount.appDataKeyBytes);
  }

  async #encryptAppDataKey({ password, appDataKeyBytes } = {}) {
    const saltBytes = randomBytes(16, this.#cryptoProvider);
    const kdfParams = getDefaultKdfParams(this.#cryptoProvider);
    const unlockKeyBytes = await deriveUnlockKey({
      password,
      saltBytes,
      kdfParams,
      cryptoProvider: this.#cryptoProvider,
    });
    try {
      const plaintextJsonBytes = new TextEncoder().encode(JSON.stringify({
        appDataKeyB64: toBase64(appDataKeyBytes),
      }));
      const encrypted = await encryptKeystore({
        unlockKeyBytes,
        plaintextJsonBytes,
        cryptoProvider: this.#cryptoProvider,
      });
      return createKeystoreEnvelope({
        kdfParams,
        saltB64: toBase64(saltBytes),
        ciphertextB64: toBase64(encrypted.ciphertextBytes),
        createdAtMs: this.#clock(),
        updatedAtMs: this.#clock(),
      });
    } finally {
      unlockKeyBytes.fill(0);
    }
  }

  async #decryptAppDataKey({ password, appKeyEnvelope, safeWrappedAppKeyB64 } = {}) {
    const saltBytes = fromBase64(appKeyEnvelope.saltB64);
    const unlockKeyBytes = await deriveUnlockKey({
      password,
      saltBytes,
      kdfParams: appKeyEnvelope.kdfParams,
      cryptoProvider: this.#cryptoProvider,
    });
    try {
      const plaintextBytes = await decryptKeystore({
        unlockKeyBytes,
        envelope: appKeyEnvelope,
        cryptoProvider: this.#cryptoProvider,
      });
      const decoded = JSON.parse(new TextDecoder().decode(plaintextBytes));
      const keyBytes = fromBase64(decoded && decoded.appDataKeyB64);
      if (!(keyBytes instanceof Uint8Array) || keyBytes.length !== 32) {
        throw new Error("Invalid app data key envelope");
      }
      this.#verifySafeWrappedAppDataKey({ appDataKeyBytes: keyBytes, safeWrappedAppKeyB64 });
      return keyBytes;
    } finally {
      unlockKeyBytes.fill(0);
    }
  }

  #safeWrapAppDataKey(appDataKeyBytes) {
    if (!safeStorageAvailable(this.#safeStorage)) return null;
    const wrapped = this.#safeStorage.encryptString(toBase64(appDataKeyBytes));
    return bufferToBase64(wrapped);
  }

  #verifySafeWrappedAppDataKey({ appDataKeyBytes, safeWrappedAppKeyB64 } = {}) {
    if (!safeStorageAvailable(this.#safeStorage)) return;
    if (!safeWrappedAppKeyB64) return;
    const unwrapped = this.#safeStorage.decryptString(base64ToBuffer(safeWrappedAppKeyB64));
    if (normalizeString(unwrapped) !== toBase64(appDataKeyBytes)) {
      throw new Error("OS wrapped vault key mismatch");
    }
  }

  #loadAccountRow(accountId) {
    const db = this.#requireDb();
    const id = normalizeString(accountId);
    if (id) {
      return db.prepare(`
        SELECT accountId, profileNameHint, keystoreEnvelopeJson, appKeyEnvelopeJson, safeWrappedAppKeyB64, safeWrappedPasswordB64, avatarFileHash, avatarDataB64
        FROM vault_accounts WHERE accountId = ?
      `).get(id);
    }
    return db.prepare(`
      SELECT accountId, profileNameHint, keystoreEnvelopeJson, appKeyEnvelopeJson, safeWrappedAppKeyB64, safeWrappedPasswordB64, avatarFileHash, avatarDataB64
      FROM vault_accounts ORDER BY updatedAtMs DESC, accountId ASC LIMIT 1
    `).get();
  }

  #clearActive() {
    if (this.#activeAccount && this.#activeAccount.appDataKeyBytes instanceof Uint8Array) {
      this.#activeAccount.appDataKeyBytes.fill(0);
    }
    this.#activeAccount = null;
    this.#clearAutoLockTimers();
  }

  #startAutoLockTimers() {
    this.#clearAutoLockTimers();
    this.#unlockedAtMs = this.#clock();
    this.#armIdleTimer();
    this.#absoluteTimer = setTimeout(() => {
      this.#absoluteTimer = null;
      this.#handleAutoLock("absolute_timeout");
    }, this.#absoluteTimeoutMs);
  }

  #armIdleTimer() {
    if (this.#idleTimer) {
      clearTimeout(this.#idleTimer);
      this.#idleTimer = null;
    }
    this.#idleTimer = setTimeout(() => {
      this.#idleTimer = null;
      this.#handleAutoLock("idle_timeout");
    }, this.#idleTimeoutMs);
  }

  #clearAutoLockTimers() {
    if (this.#idleTimer) {
      clearTimeout(this.#idleTimer);
      this.#idleTimer = null;
    }
    if (this.#absoluteTimer) {
      clearTimeout(this.#absoluteTimer);
      this.#absoluteTimer = null;
    }
    this.#unlockedAtMs = 0;
  }

  #handleAutoLock(reason) {
    // The vault may already have been locked by an explicit `lock()` call
    // since the timer was armed. In that case do nothing.
    if (!this.#activeAccount) return;
    this.lock();
    if (this.#onAutoLock) {
      try {
        this.#onAutoLock(reason);
      } catch (err) {
        console.error("[DesktopVaultService] onAutoLock callback failed: "
          + (err && err.message ? err.message : err));
      }
    }
  }

  #migrate() {
    const db = this.#requireDb();
    db.exec(`
      CREATE TABLE IF NOT EXISTS vault_accounts (
        accountId TEXT PRIMARY KEY,
        profileNameHint TEXT NOT NULL,
        keystoreEnvelopeJson TEXT NOT NULL,
        appKeyEnvelopeJson TEXT NOT NULL,
        safeWrappedAppKeyB64 TEXT,
        createdAtMs INTEGER NOT NULL,
        updatedAtMs INTEGER NOT NULL
      );
    `);
    const columns = db.prepare(`PRAGMA table_info(vault_accounts)`).all();
    const hasWrappedPassword = columns.some((c) => c.name === "safeWrappedPasswordB64");
    if (!hasWrappedPassword) {
      db.exec(`ALTER TABLE vault_accounts ADD COLUMN safeWrappedPasswordB64 TEXT`);
    }
    const hasAvatarHash = columns.some((c) => c.name === "avatarFileHash");
    if (!hasAvatarHash) {
      db.exec(`ALTER TABLE vault_accounts ADD COLUMN avatarFileHash TEXT`);
    }
    const hasAvatarData = columns.some((c) => c.name === "avatarDataB64");
    if (!hasAvatarData) {
      db.exec(`ALTER TABLE vault_accounts ADD COLUMN avatarDataB64 TEXT`);
    }
  }

  #requireDb() {
    if (!this.#db) throw new Error("DesktopVaultService is not open");
    return this.#db;
  }
}
