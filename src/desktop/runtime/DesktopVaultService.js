import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { scrypt as nodeScrypt, createHash } from "node:crypto";
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
  Identity,
  BrowserCryptoProvider,
} from "@rezprotocol/sdk/client";
// BIP39 + seed-derivation are re-exported from rez-core via @rezprotocol/sdk
// subpaths — rez-chat is forbidden from importing rez-core directly (see
// guardrails.config.json workspacePolicies.rez-chat). The Node-only nature
// of these primitives is enforced by the subpath bundling, not the barrel.
import { Bip39 } from "@rezprotocol/sdk/crypto/bip39";
import { SeedKeys } from "@rezprotocol/sdk/crypto/seedDerivation";

// Per-purpose HKDF labels for SeedKeys.deriveEd25519. NEVER rename or reuse
// a label for a different key — that would silently couple two identities.
const SEED_LABEL_DESKTOP_ACCOUNT = "rez/identity/desktop-account/v1";
const SEED_LABEL_CHAT_SERVER = "rez/identity/chat-server/v1";
// Seed-derived KEK for the portable encrypted account backup (Phase 5). The
// mnemonic is the backup key: export/import both derive this from the seed, so
// the random app-data key can be recovered on a fresh device WITHOUT the OS
// keychain. See resetPasswordWithMnemonic's docstring for why this is needed.
const SEED_LABEL_BACKUP = "rez/backup/v1";
// AAD prefix binding a backup ciphertext to its version + account id, so a
// swapped/forged envelope header fails AES-GCM authentication.
const BACKUP_AAD_PREFIX = "rez-backup/v1:";

function seedFingerprintB64(seed) {
  return createHash("sha256").update(seed).digest().slice(0, 8).toString("base64");
}

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
  #pendingChatServerIdentity;
  #idleTimeoutMs;
  #absoluteTimeoutMs;
  #idleTimer;
  #absoluteTimer;
  #unlockedAtMs;
  #onAutoLock;
  #backupAead;

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
    this.#pendingChatServerIdentity = null;
    this.#idleTimeoutMs = Number.isFinite(idleTimeoutMs) && idleTimeoutMs > 0
      ? idleTimeoutMs : DEFAULT_IDLE_TIMEOUT_MS;
    this.#absoluteTimeoutMs = Number.isFinite(absoluteTimeoutMs) && absoluteTimeoutMs > 0
      ? absoluteTimeoutMs : DEFAULT_ABSOLUTE_TIMEOUT_MS;
    this.#idleTimer = null;
    this.#absoluteTimer = null;
    this.#unlockedAtMs = 0;
    this.#onAutoLock = typeof onAutoLock === "function" ? onAutoLock : null;
    this.#backupAead = null;
  }

  // Lazily-instantiated raw-key AES-256-GCM provider for the encrypted backup
  // file. Separate from #cryptoProvider (a duck-typed scrypt/subtle object that
  // does not implement aeadEncrypt). Reuses the SDK's BrowserCryptoProvider —
  // no hand-rolled crypto.
  #requireBackupAead() {
    if (!this.#backupAead) this.#backupAead = new BrowserCryptoProvider();
    return this.#backupAead;
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
      SELECT accountId, profileNameHint, safeWrappedPasswordB64, mnemonicEnvelopeJson, createdAtMs, updatedAtMs FROM vault_accounts
      ORDER BY updatedAtMs DESC, accountId ASC
    `).all();
    return rows.map((row) => ({
      id: row.accountId,
      label: row.profileNameHint || "Account",
      accountIdHint: row.accountId,
      deviceUnlockEnabled: typeof row.safeWrappedPasswordB64 === "string" && row.safeWrappedPasswordB64.length > 0,
      // recoveryEnabled is false for pre-BIP39 rows (null mnemonicEnvelopeJson):
      // they have no recovery phrase, no backup, and no forgot-password path.
      // The lock screen uses this to route them through the Phase 6 re-create
      // migration instead of an unlock form that would fail at connect().
      recoveryEnabled: typeof row.mnemonicEnvelopeJson === "string" && row.mnemonicEnvelopeJson.length > 0,
      createdAtMs: Number(row.createdAtMs) || null,
      updatedAtMs: Number(row.updatedAtMs) || null,
    }));
  }

  async createAccount({ profileName = "", password = "", mnemonic = null } = {}) {
    const name = normalizeString(profileName);
    const pwd = String(password || "");
    if (!name) throw new Error("vault.createAccount requires profileName");
    if (pwd.length < 8) throw new Error("vault.createAccount requires password length >= 8");

    // BIP39-seeded identity. The mnemonic is the root of recovery: vault
    // identity, chat-server identity, and the backup-encryption key all derive
    // from it. Caller may pass a pre-existing mnemonic (used by the
    // backup-restore flow to re-create an account with a specific identity);
    // otherwise we mint a fresh 24-word one.
    const mnemonicText = mnemonic != null
      ? this.#validateAndNormalizeMnemonic(mnemonic)
      : Bip39.generateMnemonic({ words: 24 });
    const seed = await Bip39.mnemonicToSeed(mnemonicText);
    let appDataKeyBytes = null;
    try {
      const desktopKeys = SeedKeys.deriveEd25519({ seed, label: SEED_LABEL_DESKTOP_ACCOUNT });
      const chatServerKeys = SeedKeys.deriveEd25519({ seed, label: SEED_LABEL_CHAT_SERVER });
      const desktopIdentity = Identity.fromObject({
        publicKeyB64: desktopKeys.publicKeyB64,
        privateKeyB64: desktopKeys.privateKeyB64,
      });
      const chatServerIdentity = Identity.fromObject({
        publicKeyB64: chatServerKeys.publicKeyB64,
        privateKeyB64: chatServerKeys.privateKeyB64,
      });

      const keystoreStore = new MemoryKeystoreStore();
      const created = await createKeystoreAccount({
        password: pwd,
        profileName: name,
        keystoreStore,
        cryptoProvider: this.#cryptoProvider,
        identity: desktopIdentity,
      });
      const envelope = await keystoreStore.getKeystoreEnvelope();
      appDataKeyBytes = randomBytes(32, this.#cryptoProvider);
      const appKeyEnvelope = await this.#encryptAppDataKey({ password: pwd, appDataKeyBytes });
      const safeWrappedAppKeyB64 = await this.#safeWrapAppDataKey(appDataKeyBytes);
      const mnemonicEnvelope = await this.#encryptMnemonic({ password: pwd, mnemonic: mnemonicText });
      const fingerprint = seedFingerprintB64(seed);
      const now = this.#clock();
      this.#requireDb().prepare(`
        INSERT INTO vault_accounts (
          accountId, profileNameHint, keystoreEnvelopeJson, appKeyEnvelopeJson, safeWrappedAppKeyB64,
          mnemonicEnvelopeJson, seedFingerprintB64, createdAtMs, updatedAtMs
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        created.accountId,
        name,
        JSON.stringify(envelope),
        JSON.stringify(appKeyEnvelope),
        safeWrappedAppKeyB64,
        JSON.stringify(mnemonicEnvelope),
        fingerprint,
        now,
        now,
      );
      // Stash the just-derived chat-server identity for the immediate unlock
      // return (avoids re-running scrypt+HKDF twice on first creation).
      this.#pendingChatServerIdentity = {
        accountId: chatServerIdentity.getAccountId(),
        publicKeyB64: chatServerKeys.publicKeyB64,
        privateKeyB64: chatServerKeys.privateKeyB64,
      };
      return this.unlock({ accountId: created.accountId, password: pwd });
    } finally {
      if (appDataKeyBytes instanceof Uint8Array) appDataKeyBytes.fill(0);
      seed.fill(0);
    }
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
    await this.#healLegacyOsWrap({ row, appDataKeyBytes });
    this.#clearActive();
    // profileNameHint is the authoritative current display name once the
    // user has set one via setProfileName. The keystore payload's
    // profileName is the creation-time seed and is only used when the hint
    // is missing or still the legacy literal "Account" placeholder.
    const hintName = normalizeString(row.profileNameHint);
    const seedName = normalizeString(unlocked.profileName);
    const resolvedName = hintName && hintName !== "Account" ? hintName : seedName;
    // Resolve the chat-server identity. Order of preference:
    //   1. The just-derived identity stashed by createAccount() (avoids a
    //      redundant scrypt+HKDF round on the create→unlock chain).
    //   2. Re-derive from the mnemonic stored in the vault row.
    //   3. Null — this account predates BIP39 (Phase 6 supervisor refuses to
    //      proceed in that state with a "please re-create" prompt; this code
    //      just hands back null so the caller can detect and prompt).
    let chatServerIdentity = null;
    if (this.#pendingChatServerIdentity && this.#pendingChatServerIdentity.accountId) {
      chatServerIdentity = this.#pendingChatServerIdentity;
      this.#pendingChatServerIdentity = null;
    } else if (typeof row.mnemonicEnvelopeJson === "string" && row.mnemonicEnvelopeJson.length > 0) {
      chatServerIdentity = await this.#deriveChatServerIdentityFromVaultRow({ password: pwd, row });
    }
    this.#activeAccount = {
      accountId: unlocked.accountId,
      deviceId: unlocked.deviceId,
      profileName: resolvedName,
      identityPublicKey: unlocked.identityPublicKey,
      identityKeyPair: cloneJson(unlocked.identityKeyPair),
      appDataKeyBytes,
      chatServerIdentity,
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
      try {
        await this.#ensureSafeStorageKey();
        this.#writeWrappedPassword({ accountId: unlocked.accountId, password: pwd });
      } catch (err) {
        // Best-effort: a denied or unavailable keychain must NOT fail an
        // otherwise-successful password unlock. Device unlock just stays off
        // (the user can retry from Settings).
        console.warn(
          "[desktop-vault] could not enable device unlock during unlock:",
          err && err.message ? err.message : err,
        );
      }
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
    // Materialize the device key now (lazily fetched from the OS keychain on
    // first use). A keychain failure here surfaces as a device-unlock error;
    // the user falls back to password unlock.
    await this.#ensureSafeStorageKey();
    let recoveredPassword = null;
    try {
      recoveredPassword = this.#safeStorage.decryptString(base64ToBuffer(wrappedB64));
    } catch (err) {
      if (err && err.code === "DEVICE_UNLOCK_RESET_REQUIRED") {
        // Tauri migration: the wrapped password is an Electron-safeStorage
        // blob this process can never decrypt. Clear the dead enrollment so
        // the UI stops offering device unlock, then surface the typed error
        // — the user signs in with their password and re-enables it.
        this.disableDeviceUnlock({ accountId: row.accountId });
      }
      throw err;
    }
    if (typeof recoveredPassword !== "string" || recoveredPassword.length === 0) {
      throw new Error("Device unlock failed: saved password could not be recovered");
    }
    return this.unlock({ accountId: row.accountId, password: recoveredPassword });
  }

  async enableDeviceUnlock({ accountId = null, password = "" } = {}) {
    if (!safeStorageAvailable(this.#safeStorage)) {
      throw new Error("Device unlock unavailable: OS encryption not available");
    }
    const pwd = String(password || "");
    if (!pwd) throw new Error("enableDeviceUnlock requires password");
    const row = this.#loadAccountRow(accountId);
    if (!row) throw new Error("No vault account found");
    // Fetch the OS keychain device key now — this is the opt-in moment, so a
    // keychain prompt here is expected and intentional.
    await this.#ensureSafeStorageKey();
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

  // Materialize the safeStorage device key before a synchronous encrypt/
  // decrypt. KeyringSafeStorage fetches its OS-keychain key lazily (so no
  // boot-time prompt); Electron's safeStorage has no such method and is a
  // no-op here. The duck-type guard keeps DesktopVaultService host-agnostic.
  async #ensureSafeStorageKey() {
    if (this.#safeStorage && typeof this.#safeStorage.ensureDeviceKey === "function") {
      await this.#safeStorage.ensureDeviceKey();
    }
  }

  // Best-effort variant for the always-on OS-wrap of the app-data key (the
  // machine-binding layer). Returns true when the key is ready for synchronous
  // encrypt/decrypt. A denied/unavailable keychain returns false so the caller
  // degrades to password-only — it must NEVER block account creation/unlock.
  async #tryEnsureSafeStorageKey() {
    if (!safeStorageAvailable(this.#safeStorage)) return false;
    try {
      await this.#ensureSafeStorageKey();
      return true;
    } catch (err) {
      console.warn(
        "[desktop-vault] keychain key unavailable — OS key-wrap disabled this operation:",
        err && err.message ? err.message : err,
      );
      return false;
    }
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

  /**
   * Returns the BIP39-seed-derived chat-server identity for the active
   * account, or `null` if the vault is locked or the account predates BIP39.
   *
   * Caller (bootstrapChatServer / DesktopSupervisor) passes this as the
   * `expectedIdentity` to ensureChatServerIdentity, which (a) persists it on
   * first boot of chat-server's storage, and (b) cross-checks on subsequent
   * boots so a mismatched stored identity is detected.
   */
  getChatServerIdentity() {
    if (!this.#activeAccount) return null;
    const ident = this.#activeAccount.chatServerIdentity;
    if (!ident || !ident.accountId) return null;
    return {
      accountId: ident.accountId,
      publicKeyB64: ident.publicKeyB64,
      privateKeyB64: ident.privateKeyB64,
    };
  }

  /**
   * Decrypts the BIP39 recovery phrase for the active or specified account
   * after verifying the password (the same scrypt-derived KEK that wraps the
   * keystore envelope also wraps the mnemonic). Returns `{ mnemonic }`.
   *
   * Caller MUST treat this as a secret: never log, never persist outside the
   * vault, never expose to the renderer except via the show-recovery-phrase
   * IPC path that is gated on a fresh password prompt.
   */
  async revealMnemonic({ accountId = null, password = "" } = {}) {
    const pwd = String(password || "");
    if (!pwd) throw new Error("vault.revealMnemonic requires password");
    const row = this.#loadAccountRow(accountId);
    if (!row) throw new Error("No vault account found");
    if (typeof row.mnemonicEnvelopeJson !== "string" || row.mnemonicEnvelopeJson.length === 0) {
      throw new Error("Account has no recovery phrase (pre-BIP39 schema)");
    }
    // Verify the password by attempting a keystore decrypt — same surface area
    // as a real unlock, so a wrong password produces the same error class.
    const keystoreEnvelope = JSON.parse(row.keystoreEnvelopeJson);
    await unlockKeystoreAccount({
      password: pwd,
      keystoreStore: new MemoryKeystoreStore(keystoreEnvelope),
      cryptoProvider: this.#cryptoProvider,
    });
    const mnemonic = await this.#decryptMnemonic({
      password: pwd,
      mnemonicEnvelope: JSON.parse(row.mnemonicEnvelopeJson),
    });
    return { mnemonic };
  }

  /**
   * Forgot-password recovery: validate that the supplied mnemonic derives a
   * seed whose 8-byte SHA-256 fingerprint matches the one persisted at account
   * creation, then re-wrap the keystore + appKey + mnemonic envelopes under a
   * fresh KEK derived from `newPassword`.
   *
   * NOTE: requires that this account has device-unlock enabled (so the
   * `safeWrappedAppKeyB64` row stores the appDataKey under the OS keychain) —
   * without it, the appDataKey itself can't be recovered from the mnemonic
   * because it's per-account random and only the old password could decrypt
   * the existing appKeyEnvelope. Caller surfaces this as a hard warning at
   * recovery time. Phase 5's backup-restore flow is the alternative when
   * device-unlock wasn't enabled.
   */
  async resetPasswordWithMnemonic({ accountId = null, mnemonic = "", newPassword = "" } = {}) {
    const newPwd = String(newPassword || "");
    if (newPwd.length < 8) throw new Error("vault.resetPasswordWithMnemonic requires newPassword length >= 8");
    const row = this.#loadAccountRow(accountId);
    if (!row) throw new Error("No vault account found");
    if (typeof row.seedFingerprintB64 !== "string" || row.seedFingerprintB64.length === 0) {
      throw new Error("Account has no recovery fingerprint (pre-BIP39 schema)");
    }
    const wrappedAppKeyB64 = typeof row.safeWrappedAppKeyB64 === "string" ? row.safeWrappedAppKeyB64 : "";
    if (!wrappedAppKeyB64 || !safeStorageAvailable(this.#safeStorage)) {
      throw new Error(
        "Cannot reset password without OS-wrapped app data key. Restore from an encrypted backup or recreate the account.",
      );
    }
    const mnemonicText = this.#validateAndNormalizeMnemonic(mnemonic);
    const seed = await Bip39.mnemonicToSeed(mnemonicText);
    let newAppKeyEnvelope = null;
    let newMnemonicEnvelope = null;
    let newSafeWrappedAppKeyB64 = null;
    let appDataKeyBytes = null;
    try {
      const fingerprint = seedFingerprintB64(seed);
      if (fingerprint !== row.seedFingerprintB64) {
        throw new Error("Recovery phrase does not match this account");
      }
      const desktopKeys = SeedKeys.deriveEd25519({ seed, label: SEED_LABEL_DESKTOP_ACCOUNT });
      const desktopIdentity = Identity.fromObject({
        publicKeyB64: desktopKeys.publicKeyB64,
        privateKeyB64: desktopKeys.privateKeyB64,
      });
      // Sanity check: the derived identity must yield the row's accountId, else
      // the mnemonic+fingerprint pair was constructed under a different scheme.
      if (desktopIdentity.getAccountId() !== row.accountId) {
        throw new Error("Recovery phrase derives a different identity for this account");
      }
      // Recover the appDataKey via the OS keychain (independent of the lost
      // password) so existing app data stays decryptable post-reset.
      const unwrappedB64 = this.#safeStorage.decryptString(base64ToBuffer(wrappedAppKeyB64));
      if (typeof unwrappedB64 !== "string" || unwrappedB64.length === 0) {
        throw new Error("OS-wrapped app data key could not be recovered");
      }
      appDataKeyBytes = fromBase64(unwrappedB64);
      if (!(appDataKeyBytes instanceof Uint8Array) || appDataKeyBytes.length !== 32) {
        throw new Error("OS-wrapped app data key is malformed");
      }
      // Re-wrap everything under the new password.
      const keystoreStore = new MemoryKeystoreStore();
      const created = await createKeystoreAccount({
        password: newPwd,
        profileName: normalizeString(row.profileNameHint) || "Account",
        keystoreStore,
        cryptoProvider: this.#cryptoProvider,
        identity: desktopIdentity,
      });
      const newKeystoreEnvelope = await keystoreStore.getKeystoreEnvelope();
      newAppKeyEnvelope = await this.#encryptAppDataKey({ password: newPwd, appDataKeyBytes });
      newSafeWrappedAppKeyB64 = await this.#safeWrapAppDataKey(appDataKeyBytes);
      newMnemonicEnvelope = await this.#encryptMnemonic({ password: newPwd, mnemonic: mnemonicText });
      const now = this.#clock();
      this.#requireDb().prepare(`
        UPDATE vault_accounts SET
          keystoreEnvelopeJson = ?,
          appKeyEnvelopeJson = ?,
          safeWrappedAppKeyB64 = ?,
          mnemonicEnvelopeJson = ?,
          safeWrappedPasswordB64 = NULL,
          updatedAtMs = ?
        WHERE accountId = ?
      `).run(
        JSON.stringify(newKeystoreEnvelope),
        JSON.stringify(newAppKeyEnvelope),
        newSafeWrappedAppKeyB64,
        JSON.stringify(newMnemonicEnvelope),
        now,
        row.accountId,
      );
      this.lock();
      return { accountId: created.accountId, deviceUnlockEnabled: false };
    } finally {
      if (appDataKeyBytes instanceof Uint8Array) appDataKeyBytes.fill(0);
      seed.fill(0);
    }
  }

  /**
   * Phase 5 — export a portable, encrypted account backup. The bundle carries
   * the per-account RANDOM app-data key (NOT derivable from the mnemonic) plus
   * profile metadata, encrypted under a seed-derived KEK (SEED_LABEL_BACKUP).
   * The mnemonic is the key and is never stored in the file. Returns the file
   * envelope as a plain JSON-serializable object; file I/O is the caller's job.
   */
  async exportBackup({ accountId = null, password = "" } = {}) {
    const pwd = String(password || "");
    if (!pwd) throw new Error("vault.exportBackup requires password");
    const row = this.#loadAccountRow(accountId);
    if (!row) throw new Error("No vault account found");
    if (typeof row.mnemonicEnvelopeJson !== "string" || row.mnemonicEnvelopeJson.length === 0
      || typeof row.seedFingerprintB64 !== "string" || row.seedFingerprintB64.length === 0) {
      throw new Error("Account has no recovery phrase (pre-BIP39 schema)");
    }
    // Verify the password via a real keystore unlock (same surface as
    // revealMnemonic), so a wrong password fails before any decryption.
    await unlockKeystoreAccount({
      password: pwd,
      keystoreStore: new MemoryKeystoreStore(JSON.parse(row.keystoreEnvelopeJson)),
      cryptoProvider: this.#cryptoProvider,
    });
    const mnemonicText = await this.#decryptMnemonic({
      password: pwd,
      mnemonicEnvelope: JSON.parse(row.mnemonicEnvelopeJson),
    });
    const appDataKeyBytes = await this.#decryptAppDataKey({
      password: pwd,
      appKeyEnvelope: JSON.parse(row.appKeyEnvelopeJson),
      safeWrappedAppKeyB64: row.safeWrappedAppKeyB64,
    });
    const seed = await Bip39.mnemonicToSeed(mnemonicText);
    let kek = null;
    try {
      kek = SeedKeys.deriveBytes({ seed, label: SEED_LABEL_BACKUP, length: 32 });
      const bundle = {
        v: 1,
        accountId: row.accountId,
        profileNameHint: row.profileNameHint || "Account",
        avatarFileHash: row.avatarFileHash || null,
        avatarDataB64: row.avatarDataB64 || null,
        appDataKeyB64: toBase64(appDataKeyBytes),
        seedFingerprintB64: row.seedFingerprintB64,
        createdAtMs: Number(row.createdAtMs) || this.#clock(),
      };
      const plaintext = new TextEncoder().encode(JSON.stringify(bundle));
      const nonce = randomBytes(12, this.#cryptoProvider);
      const aad = new TextEncoder().encode(BACKUP_AAD_PREFIX + row.accountId);
      const ciphertext = await this.#requireBackupAead().aeadEncrypt({
        key: new Uint8Array(kek),
        nonce,
        plaintext,
        aad,
      });
      return {
        v: 1,
        type: "rez-backup",
        accountId: row.accountId,
        seedFingerprintB64: row.seedFingerprintB64,
        nonceB64: toBase64(nonce),
        ciphertextB64: toBase64(ciphertext),
        createdAtMs: this.#clock(),
      };
    } finally {
      if (appDataKeyBytes instanceof Uint8Array) appDataKeyBytes.fill(0);
      if (kek && typeof kek.fill === "function") kek.fill(0);
      seed.fill(0);
    }
  }

  /**
   * Phase 5 — restore an account from an encrypted backup on a fresh device.
   * Derives the KEK from the supplied mnemonic, decrypts the bundle, validates
   * the seed fingerprint + derived identity, then re-creates the vault row
   * using the RECOVERED random app-data key wrapped under newPassword. Leaves
   * the vault unlocked as the restored account. Refuses to clobber an existing
   * account with the same identity.
   */
  async importBackup({ encryptedBackup = null, mnemonic = "", newPassword = "" } = {}) {
    const newPwd = String(newPassword || "");
    if (newPwd.length < 8) throw new Error("vault.importBackup requires newPassword length >= 8");
    const env = encryptedBackup;
    if (!env || typeof env !== "object" || env.v !== 1 || env.type !== "rez-backup"
      || typeof env.accountId !== "string" || env.accountId.length === 0
      || typeof env.seedFingerprintB64 !== "string" || env.seedFingerprintB64.length === 0
      || typeof env.nonceB64 !== "string" || typeof env.ciphertextB64 !== "string") {
      throw new Error("Invalid backup file");
    }
    const mnemonicText = this.#validateAndNormalizeMnemonic(mnemonic);
    const existing = this.#requireDb().prepare(
      "SELECT accountId FROM vault_accounts WHERE accountId = ?",
    ).get(env.accountId);
    if (existing) {
      throw new Error("An account with this identity already exists on this device");
    }
    const seed = await Bip39.mnemonicToSeed(mnemonicText);
    let appDataKeyBytes = null;
    let kek = null;
    try {
      // Cheap fingerprint pre-check before the AEAD decrypt.
      const fingerprint = seedFingerprintB64(seed);
      if (fingerprint !== env.seedFingerprintB64) {
        throw new Error("Recovery phrase does not match this backup");
      }
      kek = SeedKeys.deriveBytes({ seed, label: SEED_LABEL_BACKUP, length: 32 });
      const aad = new TextEncoder().encode(BACKUP_AAD_PREFIX + env.accountId);
      let plaintext = null;
      try {
        plaintext = await this.#requireBackupAead().aeadDecrypt({
          key: new Uint8Array(kek),
          nonce: fromBase64(env.nonceB64),
          ciphertext: fromBase64(env.ciphertextB64),
          aad,
        });
      } catch (err) {
        // AEAD auth failure: surface a clear, non-leaky error (no swallow).
        throw new Error("Backup decryption failed: recovery phrase or file is invalid");
      }
      const bundle = JSON.parse(new TextDecoder().decode(plaintext));
      if (!bundle || bundle.v !== 1) throw new Error("Unsupported backup bundle version");
      appDataKeyBytes = fromBase64(bundle.appDataKeyB64);
      if (!(appDataKeyBytes instanceof Uint8Array) || appDataKeyBytes.length !== 32) {
        throw new Error("Backup app data key is malformed");
      }
      const desktopKeys = SeedKeys.deriveEd25519({ seed, label: SEED_LABEL_DESKTOP_ACCOUNT });
      const chatServerKeys = SeedKeys.deriveEd25519({ seed, label: SEED_LABEL_CHAT_SERVER });
      const desktopIdentity = Identity.fromObject({
        publicKeyB64: desktopKeys.publicKeyB64,
        privateKeyB64: desktopKeys.privateKeyB64,
      });
      // Sanity check: the derived identity must match the backup's accountId.
      if (desktopIdentity.getAccountId() !== env.accountId) {
        throw new Error("Recovery phrase derives a different identity for this backup");
      }
      const chatServerIdentity = Identity.fromObject({
        publicKeyB64: chatServerKeys.publicKeyB64,
        privateKeyB64: chatServerKeys.privateKeyB64,
      });
      const profileName = normalizeString(bundle.profileNameHint) || "Account";
      const keystoreStore = new MemoryKeystoreStore();
      const created = await createKeystoreAccount({
        password: newPwd,
        profileName,
        keystoreStore,
        cryptoProvider: this.#cryptoProvider,
        identity: desktopIdentity,
      });
      const envelope = await keystoreStore.getKeystoreEnvelope();
      // Re-wrap the RECOVERED random app-data key under the new password — the
      // whole point of the backup (recoverable without the OS keychain).
      const appKeyEnvelope = await this.#encryptAppDataKey({ password: newPwd, appDataKeyBytes });
      const safeWrappedAppKeyB64 = await this.#safeWrapAppDataKey(appDataKeyBytes);
      const mnemonicEnvelope = await this.#encryptMnemonic({ password: newPwd, mnemonic: mnemonicText });
      const now = this.#clock();
      this.#requireDb().prepare(`
        INSERT INTO vault_accounts (
          accountId, profileNameHint, keystoreEnvelopeJson, appKeyEnvelopeJson, safeWrappedAppKeyB64,
          avatarFileHash, avatarDataB64, mnemonicEnvelopeJson, seedFingerprintB64, createdAtMs, updatedAtMs
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        created.accountId,
        profileName,
        JSON.stringify(envelope),
        JSON.stringify(appKeyEnvelope),
        safeWrappedAppKeyB64,
        normalizeString(bundle.avatarFileHash) || null,
        typeof bundle.avatarDataB64 === "string" && bundle.avatarDataB64.length > 0 ? bundle.avatarDataB64 : null,
        JSON.stringify(mnemonicEnvelope),
        fingerprint,
        Number(bundle.createdAtMs) || now,
        now,
      );
      // Stash the just-derived chat-server identity so the immediate unlock
      // returns it without re-running scrypt+HKDF (mirrors createAccount).
      this.#pendingChatServerIdentity = {
        accountId: chatServerIdentity.getAccountId(),
        publicKeyB64: chatServerKeys.publicKeyB64,
        privateKeyB64: chatServerKeys.privateKeyB64,
      };
      return this.unlock({ accountId: created.accountId, password: newPwd });
    } finally {
      if (appDataKeyBytes instanceof Uint8Array) appDataKeyBytes.fill(0);
      if (kek && typeof kek.fill === "function") kek.fill(0);
      seed.fill(0);
    }
  }

  /**
   * Change the vault password while keeping the same identity + appDataKey.
   * Re-wraps the keystore, appKey, and mnemonic envelopes under a KEK derived
   * from `newPassword`. Verifies `oldPassword` by attempting the full unlock
   * chain so a wrong old password fails before any writes happen.
   *
   * Auto-locks the vault on success so the caller must unlock with the new
   * password (eliminates a "what just happened" UX). Clears device-unlock so
   * the user is prompted to re-enable with the new password.
   */
  async changePassword({ accountId = null, oldPassword = "", newPassword = "" } = {}) {
    const oldPwd = String(oldPassword || "");
    const newPwd = String(newPassword || "");
    if (!oldPwd) throw new Error("vault.changePassword requires oldPassword");
    if (newPwd.length < 8) throw new Error("vault.changePassword requires newPassword length >= 8");
    if (oldPwd === newPwd) throw new Error("vault.changePassword: new password matches old password");
    const row = this.#loadAccountRow(accountId);
    if (!row) throw new Error("No vault account found");

    // Verify old by running the full unlock chain end-to-end. This also yields
    // the plaintext appDataKey we need to re-encrypt under the new KEK.
    const keystoreEnvelope = JSON.parse(row.keystoreEnvelopeJson);
    const unlocked = await unlockKeystoreAccount({
      password: oldPwd,
      keystoreStore: new MemoryKeystoreStore(keystoreEnvelope),
      cryptoProvider: this.#cryptoProvider,
    });
    const appKeyEnvelope = JSON.parse(row.appKeyEnvelopeJson);
    const appDataKeyBytes = await this.#decryptAppDataKey({
      password: oldPwd,
      appKeyEnvelope,
      safeWrappedAppKeyB64: row.safeWrappedAppKeyB64,
    });
    let mnemonicText = null;
    if (typeof row.mnemonicEnvelopeJson === "string" && row.mnemonicEnvelopeJson.length > 0) {
      mnemonicText = await this.#decryptMnemonic({
        password: oldPwd,
        mnemonicEnvelope: JSON.parse(row.mnemonicEnvelopeJson),
      });
    }
    try {
      const desktopIdentity = Identity.fromObject({
        publicKeyB64: unlocked.identityKeyPair.publicKeyB64,
        privateKeyB64: unlocked.identityKeyPair.privateKeyB64,
      });
      const newKeystoreStore = new MemoryKeystoreStore();
      await createKeystoreAccount({
        password: newPwd,
        profileName: normalizeString(row.profileNameHint) || "Account",
        keystoreStore: newKeystoreStore,
        cryptoProvider: this.#cryptoProvider,
        identity: desktopIdentity,
      });
      const newKeystoreEnvelope = await newKeystoreStore.getKeystoreEnvelope();
      const newAppKeyEnvelope = await this.#encryptAppDataKey({ password: newPwd, appDataKeyBytes });
      const newSafeWrappedAppKeyB64 = await this.#safeWrapAppDataKey(appDataKeyBytes);
      const newMnemonicEnvelope = mnemonicText != null
        ? await this.#encryptMnemonic({ password: newPwd, mnemonic: mnemonicText })
        : null;
      const now = this.#clock();
      this.#requireDb().prepare(`
        UPDATE vault_accounts SET
          keystoreEnvelopeJson = ?,
          appKeyEnvelopeJson = ?,
          safeWrappedAppKeyB64 = ?,
          mnemonicEnvelopeJson = ?,
          safeWrappedPasswordB64 = NULL,
          updatedAtMs = ?
        WHERE accountId = ?
      `).run(
        JSON.stringify(newKeystoreEnvelope),
        JSON.stringify(newAppKeyEnvelope),
        newSafeWrappedAppKeyB64,
        newMnemonicEnvelope != null ? JSON.stringify(newMnemonicEnvelope) : null,
        now,
        row.accountId,
      );
      this.lock();
      return { accountId: row.accountId, deviceUnlockEnabled: false };
    } finally {
      // Only the app-data key is a zeroable buffer. `mnemonicText` is a JS
      // string (immutable, un-zeroable); it falls out of scope here and is
      // collected on GC. Keeping the mnemonic as bytes end-to-end is a v1
      // architectural follow-up, not a code-line fix.
      appDataKeyBytes.fill(0);
    }
  }

  /**
   * Irreversibly delete the vault row for an account. Verifies password
   * first by running the full unlock chain so an attacker with renderer
   * access can't silently nuke the vault.
   *
   * On-disk per-account data (chat-server storage, node-data dir) is owned
   * by the caller — DesktopSupervisor handles those cleanups around this call.
   */
  async purgeAccount({ accountId = null, password = "" } = {}) {
    const pwd = String(password || "");
    if (!pwd) throw new Error("vault.purgeAccount requires password");
    const row = this.#loadAccountRow(accountId);
    if (!row) throw new Error("No vault account found");

    // Password check — full unlock chain matches the unlock surface area.
    const keystoreEnvelope = JSON.parse(row.keystoreEnvelopeJson);
    await unlockKeystoreAccount({
      password: pwd,
      keystoreStore: new MemoryKeystoreStore(keystoreEnvelope),
      cryptoProvider: this.#cryptoProvider,
    });

    this.lock();
    const result = this.#requireDb().prepare(`
      DELETE FROM vault_accounts WHERE accountId = ?
    `).run(row.accountId);
    if (result.changes !== 1) {
      throw new Error(`vault.purgeAccount: expected 1 row deleted, got ${result.changes}`);
    }
    return { accountId: row.accountId, purged: true };
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
      // Materialize the keychain key (best-effort) so the machine-binding
      // verify below can run; a denied/unavailable keychain skips it.
      await this.#tryEnsureSafeStorageKey();
      this.#verifySafeWrappedAppDataKey({ appDataKeyBytes: keyBytes, safeWrappedAppKeyB64 });
      return keyBytes;
    } finally {
      unlockKeyBytes.fill(0);
    }
  }

  /**
   * Tauri migration: Electron-safeStorage ciphertexts are keyed to
   * Chromium's keychain entry and cannot be decrypted by KeyringSafeStorage.
   * When a password unlock recovers the appDataKey while the row still holds
   * a legacy OS wrap, re-wrap the key under the current scheme and drop the
   * device-unlock enrollment (its wrapped password is equally unreadable).
   * One-time per account; a no-op for rows already on the current scheme.
   */
  async #healLegacyOsWrap({ row, appDataKeyBytes } = {}) {
    if (!safeStorageAvailable(this.#safeStorage)) return;
    const wrappedB64 = typeof row.safeWrappedAppKeyB64 === "string" ? row.safeWrappedAppKeyB64 : "";
    if (!wrappedB64) return;
    // The key is already materialized here (#decryptAppDataKey ran first); a
    // missing key surfaces as DEVICE_KEY_UNAVAILABLE below and skips healing.
    try {
      this.#safeStorage.decryptString(base64ToBuffer(wrappedB64));
      return; // current-scheme wrap — nothing to heal
    } catch (err) {
      if (!err || err.code !== "DEVICE_UNLOCK_RESET_REQUIRED") {
        // Mismatch/corruption is #verifySafeWrappedAppDataKey's concern;
        // an unavailable key just means we can't heal right now.
        return;
      }
    }
    const freshWrap = await this.#safeWrapAppDataKey(appDataKeyBytes);
    this.#requireDb().prepare(`
      UPDATE vault_accounts SET safeWrappedAppKeyB64 = ?, safeWrappedPasswordB64 = NULL, updatedAtMs = ?
      WHERE accountId = ?
    `).run(freshWrap, this.#clock(), row.accountId);
    console.warn("[desktop-vault] healed legacy OS-wrapped key for " + row.accountId
      + " — device unlock needs re-enabling in Settings");
  }

  async #safeWrapAppDataKey(appDataKeyBytes) {
    // Lazily materialize the keychain key (no boot-time prompt). A denied or
    // unavailable keychain degrades to no machine-binding wrap — the password
    // envelope remains the source of truth — rather than failing the op.
    if (!(await this.#tryEnsureSafeStorageKey())) return null;
    try {
      const wrapped = this.#safeStorage.encryptString(toBase64(appDataKeyBytes));
      return bufferToBase64(wrapped);
    } catch (err) {
      if (err && err.code === "DEVICE_KEY_UNAVAILABLE") {
        console.warn("[desktop-vault] OS key-wrap skipped — keychain key unavailable");
        return null;
      }
      throw err;
    }
  }

  #verifySafeWrappedAppDataKey({ appDataKeyBytes, safeWrappedAppKeyB64 } = {}) {
    if (!safeStorageAvailable(this.#safeStorage)) return;
    if (!safeWrappedAppKeyB64) return;
    let unwrapped = null;
    try {
      unwrapped = this.#safeStorage.decryptString(base64ToBuffer(safeWrappedAppKeyB64));
    } catch (err) {
      if (err && err.code === "DEVICE_UNLOCK_RESET_REQUIRED") {
        // Legacy Electron-safeStorage wrap (Tauri migration): the blob is
        // keyed to Chromium's keychain entry and unverifiable here. The
        // appDataKey was already recovered via the password envelope, so
        // skipping verification is safe; unlock() heals the row right after
        // (re-wrap + device-unlock re-enrollment). MUST NOT fail unlock —
        // that would lock migrated users out.
        console.warn("[desktop-vault] legacy OS-wrapped key detected — verification skipped, healing on unlock");
        return;
      }
      if (err && err.code === "DEVICE_KEY_UNAVAILABLE") {
        // Keychain present but its key couldn't be materialized (denied or
        // locked). Skip the machine-binding check rather than lock the user
        // out — the app-data key was already authenticated by the password
        // envelope's AEAD decryption.
        console.warn("[desktop-vault] keychain key unavailable — machine-binding check skipped");
        return;
      }
      throw err;
    }
    if (normalizeString(unwrapped) !== toBase64(appDataKeyBytes)) {
      throw new Error("OS wrapped vault key mismatch");
    }
  }

  #loadAccountRow(accountId) {
    const db = this.#requireDb();
    const id = normalizeString(accountId);
    if (id) {
      return db.prepare(`
        SELECT accountId, profileNameHint, keystoreEnvelopeJson, appKeyEnvelopeJson, safeWrappedAppKeyB64, safeWrappedPasswordB64, avatarFileHash, avatarDataB64, mnemonicEnvelopeJson, seedFingerprintB64
        FROM vault_accounts WHERE accountId = ?
      `).get(id);
    }
    return db.prepare(`
      SELECT accountId, profileNameHint, keystoreEnvelopeJson, appKeyEnvelopeJson, safeWrappedAppKeyB64, safeWrappedPasswordB64, avatarFileHash, avatarDataB64, mnemonicEnvelopeJson, seedFingerprintB64
      FROM vault_accounts ORDER BY updatedAtMs DESC, accountId ASC LIMIT 1
    `).get();
  }

  // ---- BIP39 helpers ------------------------------------------------------

  #validateAndNormalizeMnemonic(mnemonic) {
    const v = Bip39.validateMnemonic(mnemonic);
    if (!v.ok) throw new Error(`Invalid recovery phrase: ${v.error}`);
    // Re-canonicalize (trim, lowercase, single-space) by re-encoding entropy.
    return Bip39.entropyToMnemonic(Buffer.from(v.entropyBytes));
  }

  async #encryptMnemonic({ password, mnemonic } = {}) {
    // Same scrypt + AES-GCM shape as #encryptAppDataKey, but payload is
    // `{ mnemonic }`. Salt is fresh per call so re-wrapping under a new
    // password produces an independent ciphertext.
    const saltBytes = randomBytes(16, this.#cryptoProvider);
    const kdfParams = getDefaultKdfParams(this.#cryptoProvider);
    const unlockKeyBytes = await deriveUnlockKey({
      password,
      saltBytes,
      kdfParams,
      cryptoProvider: this.#cryptoProvider,
    });
    try {
      const plaintextJsonBytes = new TextEncoder().encode(JSON.stringify({ mnemonic }));
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

  async #decryptMnemonic({ password, mnemonicEnvelope } = {}) {
    const saltBytes = fromBase64(mnemonicEnvelope.saltB64);
    const unlockKeyBytes = await deriveUnlockKey({
      password,
      saltBytes,
      kdfParams: mnemonicEnvelope.kdfParams,
      cryptoProvider: this.#cryptoProvider,
    });
    try {
      const plaintextBytes = await decryptKeystore({
        unlockKeyBytes,
        envelope: mnemonicEnvelope,
        cryptoProvider: this.#cryptoProvider,
      });
      const decoded = JSON.parse(new TextDecoder().decode(plaintextBytes));
      const mnemonic = typeof decoded.mnemonic === "string" ? decoded.mnemonic : "";
      if (!mnemonic) throw new Error("Decrypted mnemonic envelope is empty");
      return mnemonic;
    } finally {
      unlockKeyBytes.fill(0);
    }
  }

  async #deriveChatServerIdentityFromVaultRow({ password, row } = {}) {
    const mnemonic = await this.#decryptMnemonic({
      password,
      mnemonicEnvelope: JSON.parse(row.mnemonicEnvelopeJson),
    });
    const seed = await Bip39.mnemonicToSeed(mnemonic);
    try {
      const chatServerKeys = SeedKeys.deriveEd25519({ seed, label: SEED_LABEL_CHAT_SERVER });
      const identity = Identity.fromObject({
        publicKeyB64: chatServerKeys.publicKeyB64,
        privateKeyB64: chatServerKeys.privateKeyB64,
      });
      return {
        accountId: identity.getAccountId(),
        publicKeyB64: chatServerKeys.publicKeyB64,
        privateKeyB64: chatServerKeys.privateKeyB64,
      };
    } finally {
      seed.fill(0);
    }
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
    // BIP39 recovery columns. These are nullable on disk so the migration is
    // safe to run against pre-BIP39 rows (which DesktopSupervisor refuses to
    // unlock with a "please re-create" prompt — see Phase 6). New accounts
    // created via createAccount() always populate them.
    const hasMnemonicEnv = columns.some((c) => c.name === "mnemonicEnvelopeJson");
    if (!hasMnemonicEnv) {
      db.exec(`ALTER TABLE vault_accounts ADD COLUMN mnemonicEnvelopeJson TEXT`);
    }
    const hasSeedFp = columns.some((c) => c.name === "seedFingerprintB64");
    if (!hasSeedFp) {
      db.exec(`ALTER TABLE vault_accounts ADD COLUMN seedFingerprintB64 TEXT`);
    }
  }

  #requireDb() {
    if (!this.#db) throw new Error("DesktopVaultService is not open");
    return this.#db;
  }
}
