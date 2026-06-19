const MAILBOX_PREFIX = "chat-server:inbox:apply-outbox:v1:";

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
 * Audit P1.2 (crash-consistency): each mailbox's staged entries live in ONE KV
 * value (a `{ [dedupId]: entry }` map under a single per-mailbox key), so every
 * mutation — stage / markApplied / recordApplyFailure — is a SINGLE atomic
 * `set`. The earlier design wrote the entry and a separate pending-index in two
 * ops; a tear between them stranded the entry invisibly to `listPending` (the
 * reproduced `{entryExists:true, pending:0}`). With one record there is no
 * second write to tear against: an entry is enumerable the instant it is
 * durable, and never otherwise.
 *
 * Single-writer per mailbox: the chat-server owns a mailbox's drain, and every
 * outbox mutation runs serialized on the InboundDepositPipeline's submit queue,
 * so the read-modify-write of the per-mailbox map never interleaves. Backed by
 * `getKeyValueStore(null)`.
 */
export class InboundApplyOutbox {
  #kvStore;

  constructor({ kvStore } = {}) {
    if (!kvStore || typeof kvStore.get !== "function" || typeof kvStore.set !== "function" || typeof kvStore.delete !== "function") {
      throw new Error("InboundApplyOutbox requires kvStore with get/set/delete");
    }
    this.#kvStore = kvStore;
  }

  #mailboxKey(mailboxId) {
    return MAILBOX_PREFIX + mailboxId;
  }

  #ids(mailboxId, dedupId) {
    const mbox = typeof mailboxId === "string" ? mailboxId.trim() : "";
    const dedup = typeof dedupId === "string" ? dedupId.trim() : "";
    if (!mbox || !dedup) return null;
    return { mailboxId: mbox, dedupId: dedup };
  }

  // The per-mailbox map of staged entries, normalized to a plain object.
  async #loadMap(mailboxId) {
    const stored = await this.#kvStore.get(this.#mailboxKey(mailboxId));
    return stored && typeof stored === "object" && !Array.isArray(stored) ? stored : {};
  }

  // Persist the per-mailbox map (one atomic write), pruning to empty → delete so
  // a fully-drained mailbox leaves no key behind.
  async #saveMap(mailboxId, map) {
    const key = this.#mailboxKey(mailboxId);
    if (!map || Object.keys(map).length === 0) {
      await this.#kvStore.delete(key);
      return;
    }
    await this.#kvStore.set(key, map);
  }

  /**
   * Durably stage a decrypted payload. Idempotent: re-staging an existing entry
   * preserves its attempt counter + firstStagedAtMs (so a redelivery does not
   * reset poison accounting). Returns true if a new entry was written.
   */
  async stage(mailboxId, dedupId, userMessage, { nowMs = Date.now() } = {}) {
    const ids = this.#ids(mailboxId, dedupId);
    if (!ids) return false;
    const map = await this.#loadMap(ids.mailboxId);
    if (map[ids.dedupId] != null) return false;
    map[ids.dedupId] = {
      mailboxId: ids.mailboxId,
      dedupId: ids.dedupId,
      userMessage,
      attempts: 0,
      firstStagedAtMs: Number.isFinite(nowMs) ? Number(nowMs) : Date.now(),
      lastAttemptAtMs: null,
    };
    await this.#saveMap(ids.mailboxId, map);
    return true;
  }

  async get(mailboxId, dedupId) {
    const ids = this.#ids(mailboxId, dedupId);
    if (!ids) return null;
    const map = await this.#loadMap(ids.mailboxId);
    const entry = map[ids.dedupId];
    return entry == null ? null : entry;
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
    const map = await this.#loadMap(ids.mailboxId);
    if (map[ids.dedupId] == null) return;
    delete map[ids.dedupId];
    await this.#saveMap(ids.mailboxId, map);
  }

  /**
   * Record an apply failure (leaves the entry staged for retry). Returns the new
   * attempt count + firstStagedAtMs so the caller can apply a poison bound.
   */
  async recordApplyFailure(mailboxId, dedupId, { nowMs = Date.now() } = {}) {
    const ids = this.#ids(mailboxId, dedupId);
    if (!ids) return { attempts: 0, firstStagedAtMs: null };
    const map = await this.#loadMap(ids.mailboxId);
    const entry = map[ids.dedupId];
    if (entry == null) return { attempts: 0, firstStagedAtMs: null };
    const attempts = (Number.isFinite(entry.attempts) ? Number(entry.attempts) : 0) + 1;
    map[ids.dedupId] = {
      ...entry,
      attempts,
      lastAttemptAtMs: Number.isFinite(nowMs) ? Number(nowMs) : Date.now(),
    };
    await this.#saveMap(ids.mailboxId, map);
    return { attempts, firstStagedAtMs: entry.firstStagedAtMs };
  }

  /**
   * All currently-staged (unapplied) entries for a mailbox, for the retry pass.
   */
  async listPending(mailboxId) {
    const mbox = typeof mailboxId === "string" ? mailboxId.trim() : "";
    if (!mbox) return [];
    const map = await this.#loadMap(mbox);
    return Object.values(map).filter((entry) => entry != null);
  }
}
