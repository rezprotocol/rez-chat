const ENTRY_PREFIX = "chat-server:inbox:apply-outbox:v1:";
const INDEX_PREFIX = "chat-server:inbox:apply-outbox-index:v1:";

/**
 * Durable post-decrypt staging (apply-outbox) for the inbound deposit pipeline.
 *
 * Audit P1.1: once a deposit is decrypted the double ratchet has ADVANCED, so
 * the ciphertext can never be re-decrypted. If the durable cursor were allowed
 * to advance (pruning that ciphertext) before the decrypted plaintext was
 * durably persisted, an application failure (DB locked/full, a bug) would lose
 * the message with no way to recover it.
 *
 * So the pipeline STAGES the decrypted payload here — in the chat-server's
 * durable KV — BEFORE the cursor may advance. The cursor advances once the
 * plaintext is staged-or-applied (never on decrypt alone). Application is then
 * retried from the outbox (no re-decrypt needed); an entry is removed once
 * applied, and a poison entry (repeated apply failures) is surfaced as a System
 * notice and dropped so it can't retry forever.
 *
 * A per-mailbox index of pending dedupIds lets `listPending` enumerate without
 * requiring a `keys()`/scan on the KV. Backed by `getKeyValueStore(null)`.
 */
export class InboundApplyOutbox {
  #kvStore;

  constructor({ kvStore } = {}) {
    if (!kvStore || typeof kvStore.get !== "function" || typeof kvStore.set !== "function" || typeof kvStore.delete !== "function") {
      throw new Error("InboundApplyOutbox requires kvStore with get/set/delete");
    }
    this.#kvStore = kvStore;
  }

  #entryKey(mailboxId, dedupId) {
    return ENTRY_PREFIX + mailboxId + ":" + dedupId;
  }

  #indexKey(mailboxId) {
    return INDEX_PREFIX + mailboxId;
  }

  #ids(mailboxId, dedupId) {
    const mbox = typeof mailboxId === "string" ? mailboxId.trim() : "";
    const dedup = typeof dedupId === "string" ? dedupId.trim() : "";
    if (!mbox || !dedup) return null;
    return { mailboxId: mbox, dedupId: dedup };
  }

  /**
   * Durably stage a decrypted payload. Idempotent: re-staging an existing entry
   * preserves its attempt counter + firstStagedAtMs (so a redelivery does not
   * reset poison accounting). Returns true if a new entry was written.
   */
  async stage(mailboxId, dedupId, userMessage, { nowMs = Date.now() } = {}) {
    const ids = this.#ids(mailboxId, dedupId);
    if (!ids) return false;
    const key = this.#entryKey(ids.mailboxId, ids.dedupId);
    const existing = await this.#kvStore.get(key);
    if (existing != null) return false;
    await this.#kvStore.set(key, {
      mailboxId: ids.mailboxId,
      dedupId: ids.dedupId,
      userMessage,
      attempts: 0,
      firstStagedAtMs: Number.isFinite(nowMs) ? Number(nowMs) : Date.now(),
      lastAttemptAtMs: null,
    });
    await this.#addToIndex(ids.mailboxId, ids.dedupId);
    return true;
  }

  async get(mailboxId, dedupId) {
    const ids = this.#ids(mailboxId, dedupId);
    if (!ids) return null;
    const stored = await this.#kvStore.get(this.#entryKey(ids.mailboxId, ids.dedupId));
    return stored == null ? null : stored;
  }

  async has(mailboxId, dedupId) {
    return (await this.get(mailboxId, dedupId)) != null;
  }

  /**
   * Applied → remove from the outbox (the message store is now the durable home).
   */
  async markApplied(mailboxId, dedupId) {
    const ids = this.#ids(mailboxId, dedupId);
    if (!ids) return;
    await this.#kvStore.delete(this.#entryKey(ids.mailboxId, ids.dedupId));
    await this.#removeFromIndex(ids.mailboxId, ids.dedupId);
  }

  /**
   * Record an apply failure (leaves the entry staged for retry). Returns the new
   * attempt count + firstStagedAtMs so the caller can apply a poison bound.
   */
  async recordApplyFailure(mailboxId, dedupId, { nowMs = Date.now() } = {}) {
    const ids = this.#ids(mailboxId, dedupId);
    if (!ids) return { attempts: 0, firstStagedAtMs: null };
    const key = this.#entryKey(ids.mailboxId, ids.dedupId);
    const entry = await this.#kvStore.get(key);
    if (entry == null) return { attempts: 0, firstStagedAtMs: null };
    const attempts = (Number.isFinite(entry.attempts) ? Number(entry.attempts) : 0) + 1;
    await this.#kvStore.set(key, {
      ...entry,
      attempts,
      lastAttemptAtMs: Number.isFinite(nowMs) ? Number(nowMs) : Date.now(),
    });
    return { attempts, firstStagedAtMs: entry.firstStagedAtMs };
  }

  /**
   * All currently-staged (unapplied) entries for a mailbox, for the retry pass.
   */
  async listPending(mailboxId) {
    const mbox = typeof mailboxId === "string" ? mailboxId.trim() : "";
    if (!mbox) return [];
    const index = await this.#kvStore.get(this.#indexKey(mbox));
    const ids = Array.isArray(index) ? index : [];
    const out = [];
    for (const dedupId of ids) {
      const entry = await this.#kvStore.get(this.#entryKey(mbox, dedupId));
      if (entry != null) out.push(entry);
    }
    return out;
  }

  async #addToIndex(mailboxId, dedupId) {
    const key = this.#indexKey(mailboxId);
    const index = await this.#kvStore.get(key);
    const ids = Array.isArray(index) ? index.slice() : [];
    if (!ids.includes(dedupId)) {
      ids.push(dedupId);
      await this.#kvStore.set(key, ids);
    }
  }

  async #removeFromIndex(mailboxId, dedupId) {
    const key = this.#indexKey(mailboxId);
    const index = await this.#kvStore.get(key);
    if (!Array.isArray(index)) return;
    const ids = index.filter((id) => id !== dedupId);
    if (ids.length !== index.length) {
      await this.#kvStore.set(key, ids);
    }
  }
}
