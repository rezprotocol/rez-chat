import { Hash } from "@rezprotocol/sdk/hash";
import { nonEmpty } from "./coerce.js";

const RETENTION_DAYS_DEFAULT = 90;
const RETENTION_DAYS_MIN = 1;
const RETENTION_DAYS_MAX = 3650;

function clampRetentionDays(value, fallback = RETENTION_DAYS_DEFAULT) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(RETENTION_DAYS_MIN, Math.min(RETENTION_DAYS_MAX, Math.floor(n)));
}

function toFiniteMs(value, fallback = Date.now()) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : Math.floor(fallback);
}

function toSeq(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new Error("seq must be non-negative integer");
  return n;
}

function sizeClassOf(ciphertextB64 = "") {
  const len = String(ciphertextB64 || "").length;
  if (len <= 4_096) return "xs";
  if (len <= 32_768) return "s";
  if (len <= 262_144) return "m";
  if (len <= 1_048_576) return "l";
  return "xl";
}

function hashAccountId(accountId) {
  return Hash.sha256Hex(String(accountId)).slice(0, 32);
}

function parseArtifactFromValue(value) {
  const src = value && typeof value === "object" ? value : null;
  if (!src) return null;
  const type = src.type === "checkpoint" ? "checkpoint" : src.type === "delta" ? "delta" : null;
  if (!type) return null;
  const seq = Number(src.seq);
  if (!Number.isInteger(seq) || seq < 0) return null;
  const createdAtMs = Number(src.createdAtMs);
  const expiresAtMs = Number(src.expiresAtMs);
  if (!Number.isFinite(createdAtMs) || !Number.isFinite(expiresAtMs)) return null;
  const ciphertextB64 = String(src.ciphertextB64 || "");
  if (!ciphertextB64) return null;
  return {
    v: 1,
    type,
    seq,
    createdAtMs,
    expiresAtMs,
    sizeClass: String(src.sizeClass || sizeClassOf(ciphertextB64)),
    ciphertextB64,
  };
}

export class BackupStoreService {
  constructor({ storageProvider, ownerAccountId, clock = () => Date.now(), retentionDays = RETENTION_DAYS_DEFAULT } = {}) {
    if (!storageProvider || typeof storageProvider.getKeyValueStore !== "function") {
      throw new Error("BackupStoreService requires storageProvider");
    }
    const owner = nonEmpty(ownerAccountId);
    if (!owner) throw new Error("BackupStoreService requires ownerAccountId");

    this._kv = storageProvider.getKeyValueStore(owner);
    if (!this._kv || typeof this._kv.get !== "function" || typeof this._kv.set !== "function" || typeof this._kv.keys !== "function") {
      throw new Error("BackupStoreService requires key-value store with get/set/keys");
    }

    this._ownerAccountId = owner;
    this._ownerHash = hashAccountId(owner);
    this._clock = typeof clock === "function" ? clock : (() => Date.now());
    this._retentionDays = clampRetentionDays(retentionDays);
  }

  retentionDays() {
    return this._retentionDays;
  }

  accountHash() {
    return this._ownerHash;
  }

  async putDelta({ seq, createdAtMs = null, sizeClass = null, encryptedDelta } = {}) {
    const normalizedSeq = toSeq(seq);
    const ciphertextB64 = String(encryptedDelta || "").trim();
    if (!ciphertextB64) throw new Error("encryptedDelta required");
    const now = toFiniteMs(this._clock());
    const created = toFiniteMs(createdAtMs, now);
    const expiresAtMs = created + this._retentionDays * 24 * 60 * 60 * 1000;

    const artifact = {
      v: 1,
      type: "delta",
      seq: normalizedSeq,
      createdAtMs: created,
      expiresAtMs,
      sizeClass: nonEmpty(sizeClass) || sizeClassOf(ciphertextB64),
      ciphertextB64,
    };

    await this._kv.set(this._artifactKey("delta", normalizedSeq), artifact);
    await this._upsertMeta({ lastBackupAtMs: now, lastDeltaSeq: normalizedSeq });
    await this._upsertManifest();

    return {
      ok: true,
      seq: normalizedSeq,
      createdAtMs: created,
      expiresAtMs,
      sizeClass: artifact.sizeClass,
      accountHash: this._ownerHash,
    };
  }

  async putCheckpoint({ seq, createdAtMs = null, encryptedCheckpoint } = {}) {
    const normalizedSeq = toSeq(seq);
    const ciphertextB64 = String(encryptedCheckpoint || "").trim();
    if (!ciphertextB64) throw new Error("encryptedCheckpoint required");
    const now = toFiniteMs(this._clock());
    const created = toFiniteMs(createdAtMs, now);
    const expiresAtMs = created + this._retentionDays * 24 * 60 * 60 * 1000;

    const artifact = {
      v: 1,
      type: "checkpoint",
      seq: normalizedSeq,
      createdAtMs: created,
      expiresAtMs,
      sizeClass: sizeClassOf(ciphertextB64),
      ciphertextB64,
    };

    await this._kv.set(this._artifactKey("checkpoint", normalizedSeq), artifact);
    await this._upsertMeta({ lastBackupAtMs: now, checkpointVersion: normalizedSeq, lastCheckpointSeq: normalizedSeq });
    await this._upsertManifest();

    return {
      ok: true,
      seq: normalizedSeq,
      createdAtMs: created,
      expiresAtMs,
      accountHash: this._ownerHash,
    };
  }

  async list({ afterSeq = null, limit = 200 } = {}) {
    const max = Math.max(1, Math.min(500, Number(limit) || 200));
    const keys = await Promise.resolve(this._kv.keys(this._basePrefix()));
    const artifacts = [];
    for (const key of keys) {
      if (!key.includes("/checkpoint/") && !key.includes("/delta/")) continue;
      const value = await Promise.resolve(this._kv.get(key));
      const artifact = parseArtifactFromValue(value);
      if (!artifact) continue;
      if (afterSeq != null && Number.isFinite(Number(afterSeq)) && artifact.seq <= Number(afterSeq)) continue;
      if (artifact.expiresAtMs <= this._clock()) continue;
      artifacts.push(artifact);
    }

    artifacts.sort((a, b) => {
      if (a.seq !== b.seq) return a.seq - b.seq;
      if (a.type !== b.type) return a.type === "checkpoint" ? -1 : 1;
      return a.createdAtMs - b.createdAtMs;
    });

    const selected = artifacts.slice(0, max);
    const meta = await this._getMeta();

    return {
      accountHash: this._ownerHash,
      retentionDays: this._retentionDays,
      lastBackupAtMs: Number((meta && meta.lastBackupAtMs) || 0) || null,
      checkpointVersion: Number((meta && meta.checkpointVersion) || 0) || null,
      items: selected.map((item) => ({
        type: item.type,
        seq: item.seq,
        createdAtMs: item.createdAtMs,
        expiresAtMs: item.expiresAtMs,
        sizeClass: item.sizeClass,
        blobHandle: this._blobHandle(item.type, item.seq),
      })),
    };
  }

  async getBlob({ type, seq } = {}) {
    const normalizedType = type === "checkpoint" ? "checkpoint" : type === "delta" ? "delta" : "";
    if (!normalizedType) throw new Error("type must be checkpoint or delta");
    const normalizedSeq = toSeq(seq);
    const value = await Promise.resolve(this._kv.get(this._artifactKey(normalizedType, normalizedSeq)));
    const artifact = parseArtifactFromValue(value);
    if (!artifact || artifact.expiresAtMs <= this._clock()) return null;
    return {
      accountHash: this._ownerHash,
      type: artifact.type,
      seq: artifact.seq,
      createdAtMs: artifact.createdAtMs,
      expiresAtMs: artifact.expiresAtMs,
      sizeClass: artifact.sizeClass,
      ciphertextB64: artifact.ciphertextB64,
    };
  }

  async prune({ nowMs = null } = {}) {
    const now = toFiniteMs(nowMs, this._clock());
    const keys = await Promise.resolve(this._kv.keys(this._basePrefix()));
    let deleted = 0;
    for (const key of keys) {
      if (!key.includes("/checkpoint/") && !key.includes("/delta/")) continue;
      const value = await Promise.resolve(this._kv.get(key));
      const artifact = parseArtifactFromValue(value);
      if (!artifact) {
        await Promise.resolve(this._kv.delete(key));
        deleted += 1;
        continue;
      }
      if (artifact.expiresAtMs > now) continue;
      await Promise.resolve(this._kv.delete(key));
      deleted += 1;
    }
    await this._upsertManifest();
    return { deleted, nowMs: now };
  }

  async _upsertManifest() {
    const listed = await this.list({ afterSeq: null, limit: 5000 });
    const latestCheckpoint = listed.items
      .filter((item) => item.type === "checkpoint")
      .sort((a, b) => b.seq - a.seq)[0] || null;
    const latestSeq = listed.items.reduce((max, item) => Math.max(max, item.seq), 0);

    const manifest = {
      v: 1,
      accountHash: this._ownerHash,
      retentionDays: this._retentionDays,
      updatedAtMs: toFiniteMs(this._clock()),
      latestSeq: Number.isFinite(latestSeq) ? latestSeq : 0,
      latestCheckpointSeq: latestCheckpoint ? latestCheckpoint.seq : null,
      itemCount: listed.items.length,
    };
    await Promise.resolve(this._kv.set(this._manifestKey(), manifest));
    return manifest;
  }

  async _getMeta() {
    const value = await Promise.resolve(this._kv.get(this._metaKey()));
    if (!value || typeof value !== "object") {
      return {
        v: 1,
        retentionDays: this._retentionDays,
        lastBackupAtMs: null,
        checkpointVersion: null,
        accountHash: this._ownerHash,
      };
    }
    return value;
  }

  async _upsertMeta(patch = {}) {
    const current = await this._getMeta();
    const next = {
      ...current,
      v: 1,
      retentionDays: this._retentionDays,
      accountHash: this._ownerHash,
      updatedAtMs: toFiniteMs(this._clock()),
      ...patch,
    };
    await Promise.resolve(this._kv.set(this._metaKey(), next));
    return next;
  }

  _basePrefix() {
    return `app:backup/${this._ownerHash}/`;
  }

  _metaKey() {
    return `${this._basePrefix()}meta`;
  }

  _manifestKey() {
    return `${this._basePrefix()}manifest`;
  }

  _artifactKey(type, seq) {
    return `${this._basePrefix()}${type}/${String(seq).padStart(12, "0")}`;
  }

  _blobHandle(type, seq) {
    return `${type}:${seq}`;
  }
}
