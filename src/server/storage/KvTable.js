import { Hash } from "@rezprotocol/sdk/hash";
import { coerceRow } from "../../records/domain/coerce.js";

/**
 * KvTable: composition helper for KV-backed CRUD against a single RRecord
 * subclass. A store composes one KvTable per record kind it manages
 * (ChatGroupStore has two: groups + memberships) and layers domain methods
 * on top.
 *
 * Concerns owned by this class:
 *   - key construction: `prefix + parts.join("/")`, optionally hashing each
 *     part (sha256 base64url, truncated)
 *   - read-side coercion: rehydrates raw KV rows via coerceRow, dropping
 *     anything that fails record construction at the trust boundary
 *   - write-side enforcement: requires a record instance; never persists a
 *     plain object
 *
 * Concerns owned by the calling store:
 *   - business logic (upsert merge, sort order, filtering)
 *   - cross-table coordination
 *   - patch-then-construct flows
 */
export class KvTable {
  constructor({
    kv,
    prefix,
    record,
    label,
    clock = null,
    hashParts = false,
    hashLen = 24,
    seedFn = null,
    extraValidate = null,
  } = {}) {
    if (!kv || typeof kv.get !== "function" || typeof kv.set !== "function" || typeof kv.keys !== "function") {
      throw new Error("KvTable requires kv with get/set/keys");
    }
    if (typeof prefix !== "string" || !prefix) {
      throw new Error("KvTable requires non-empty prefix");
    }
    if (typeof record !== "function") {
      throw new Error("KvTable requires record class");
    }
    if (seedFn !== null && typeof seedFn !== "function") {
      throw new Error("KvTable seedFn must be a function or null");
    }
    if (clock !== null && typeof clock !== "function") {
      throw new Error("KvTable clock must be a function or null");
    }
    if (extraValidate !== null && typeof extraValidate !== "function") {
      throw new Error("KvTable extraValidate must be a function or null");
    }
    this.kv = kv;
    this.prefix = prefix;
    this.record = record;
    this.label = label || record.name || "KvTable";
    this.clock = clock || (() => Date.now());
    this.hashParts = hashParts === true;
    this.hashLen = Math.max(8, Math.min(64, Math.trunc(hashLen) || 24));
    this.seedFn = seedFn;
    this.extraValidate = extraValidate;
  }

  /** Resolve a full KV key from path parts (the prefix is prepended). */
  key(...parts) {
    return this.prefix + parts.map((p) => this._part(p)).join("/");
  }

  /** Resolve a KV prefix for list/scan, with a trailing "/" delimiter. */
  prefixOf(...parts) {
    if (parts.length === 0) return this.prefix;
    return this.prefix + parts.map((p) => this._part(p)).join("/") + "/";
  }

  /** Read a single row; returns a record instance or null on miss/invalid. */
  async get(...parts) {
    const raw = await this.kv.get(this.key(...parts));
    return this._coerce(raw);
  }

  /** Coerce a raw object through the record class (no KV read). */
  coerce(raw) {
    return this._coerce(raw);
  }

  /** Persist a record instance. Plain objects are rejected. */
  async set(record, ...parts) {
    if (!(record instanceof this.record)) {
      throw new Error(`${this.label}.set requires ${this.record.name} instance`);
    }
    await this.kv.set(this.key(...parts), record);
  }

  /** Delete a single row. */
  async delete(...parts) {
    await this.kv.delete(this.key(...parts));
  }

  /**
   * List every record under a (sub-)prefix. Returns records in arbitrary
   * order — callers sort as their domain requires. Rows that fail coerce
   * are dropped silently (logged inside coerceRow).
   */
  async list(...parts) {
    const keys = await this.kv.keys(this.prefixOf(...parts));
    const out = [];
    for (const key of keys) {
      const raw = await this.kv.get(key);
      const record = this._coerce(raw);
      if (record) out.push(record);
    }
    return out;
  }

  _coerce(raw) {
    const seed = this.seedFn ? this.seedFn(this.clock()) : null;
    const record = coerceRow(this.record, raw, { seed, label: this.label });
    if (record && this.extraValidate && !this.extraValidate(record)) return null;
    return record;
  }

  _part(value) {
    const id = String(value || "").trim();
    if (!this.hashParts) return id;
    const bytes = Hash.sha256(new TextEncoder().encode(id));
    return Buffer.from(bytes).toString("base64url").slice(0, this.hashLen);
  }
}
