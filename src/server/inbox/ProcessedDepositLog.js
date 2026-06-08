const KEY_PREFIX = "chat-server:inbox:processed:v1:";
const ATTEMPT_PREFIX = "chat-server:inbox:attempts:v1:";

/**
 * Per-(mailbox,event) "already decrypted + consumed" marker for the inbound
 * deposit pipeline, plus a per-(mailbox,event) failed-decrypt attempt counter.
 *
 * Why the processed marker exists: a deposit can be delivered TWICE to the
 * chat-server — once live via the SDK push (MailboxPushBridge) and again by the
 * catch-up drain (InboxCatchupService). Re-running the SECOND copy through the
 * peer-link decrypt is NOT a harmless "redundant decode": the double ratchet has
 * already advanced past that ciphertext, so the re-decrypt fails with an AES-GCM
 * auth error. That dropped the genuinely-new offline message that followed it.
 * Marking each eventId processed AFTER a successful decrypt lets the pipeline
 * skip the re-decrypt; the consume layers then ack/delete the buffer copy.
 *
 * Why the attempt counter exists (D1): the consume layers now LEAVE an
 * undecryptable deposit buffered to retry on the next drain (a failed decrypt
 * does not commit the ratchet, so transient/ordering failures self-heal). A
 * genuinely poison deposit would otherwise retry forever, so the drain
 * quarantines (acks + drops) it once `attempts` crosses a bound. Counters are
 * cleared when a deposit is finally acked.
 *
 * Bounded by pruning: the drain forget()s the processed marker and
 * clearAttempts() the counter the moment it acks an eventId, so both sets stay
 * small. Backed by the chat-server's global KV (`getKeyValueStore(null)`).
 */
export class ProcessedDepositLog {
  #kvStore;

  constructor({ kvStore } = {}) {
    if (!kvStore || typeof kvStore.get !== "function" || typeof kvStore.set !== "function") {
      throw new Error("ProcessedDepositLog requires kvStore with get/set");
    }
    this.#kvStore = kvStore;
  }

  #key(mailboxId, eventId) {
    return KEY_PREFIX + mailboxId + ":" + eventId;
  }

  #attemptKey(mailboxId, eventId) {
    return ATTEMPT_PREFIX + mailboxId + ":" + eventId;
  }

  async has(mailboxId, eventId) {
    const ids = this.#ids(mailboxId, eventId);
    if (!ids) return false;
    const stored = await this.#kvStore.get(this.#key(ids.mailboxId, ids.eventId));
    return stored != null;
  }

  async mark(mailboxId, eventId, { nowMs = Date.now() } = {}) {
    const ids = this.#ids(mailboxId, eventId);
    if (!ids) return;
    await this.#kvStore.set(this.#key(ids.mailboxId, ids.eventId), {
      mailboxId: ids.mailboxId,
      eventId: ids.eventId,
      processedAtMs: Number.isFinite(nowMs) ? Number(nowMs) : Date.now(),
    });
  }

  async forget(mailboxId, eventId) {
    const ids = this.#ids(mailboxId, eventId);
    if (!ids) return;
    if (typeof this.#kvStore.delete !== "function") return;
    await this.#kvStore.delete(this.#key(ids.mailboxId, ids.eventId));
  }

  /**
   * Increment and persist the failed-decrypt attempt counter for an event,
   * returning the new count. Used by the drain to bound poison retries (D1).
   */
  async recordAttempt(mailboxId, eventId, { nowMs = Date.now() } = {}) {
    const ids = this.#ids(mailboxId, eventId);
    if (!ids) return 0;
    const key = this.#attemptKey(ids.mailboxId, ids.eventId);
    const stored = await this.#kvStore.get(key);
    const prev = stored && Number.isInteger(stored.attempts) ? stored.attempts : 0;
    const attempts = prev + 1;
    const now = Number.isFinite(nowMs) ? Number(nowMs) : Date.now();
    // firstSeenAtMs is set on the FIRST failed attempt and preserved thereafter —
    // it anchors the age-based quarantine bound (D1) so a permanently-undecryptable
    // deposit is dropped after a wall-clock window, not only after N reconnect
    // drains. Measured from first-failure (not deposit time) so legitimate
    // recovery (rehandshake) and ordering races get the full window.
    const firstSeenAtMs = stored && Number.isFinite(stored.firstSeenAtMs) ? Number(stored.firstSeenAtMs) : now;
    await this.#kvStore.set(key, {
      mailboxId: ids.mailboxId,
      eventId: ids.eventId,
      attempts,
      firstSeenAtMs,
      lastAttemptAtMs: now,
    });
    return attempts;
  }

  async attempts(mailboxId, eventId) {
    const ids = this.#ids(mailboxId, eventId);
    if (!ids) return 0;
    const stored = await this.#kvStore.get(this.#attemptKey(ids.mailboxId, ids.eventId));
    return stored && Number.isInteger(stored.attempts) ? stored.attempts : 0;
  }

  /**
   * The timestamp of the FIRST recorded failed-decrypt attempt for an event
   * (0 if none). Used by the drain to age-bound poison retention (D1).
   */
  async firstSeenAtMs(mailboxId, eventId) {
    const ids = this.#ids(mailboxId, eventId);
    if (!ids) return 0;
    const stored = await this.#kvStore.get(this.#attemptKey(ids.mailboxId, ids.eventId));
    return stored && Number.isFinite(stored.firstSeenAtMs) ? Number(stored.firstSeenAtMs) : 0;
  }

  async clearAttempts(mailboxId, eventId) {
    const ids = this.#ids(mailboxId, eventId);
    if (!ids) return;
    if (typeof this.#kvStore.delete !== "function") return;
    await this.#kvStore.delete(this.#attemptKey(ids.mailboxId, ids.eventId));
  }

  #ids(mailboxId, eventId) {
    const m = typeof mailboxId === "string" ? mailboxId.trim() : "";
    const e = typeof eventId === "string" ? eventId.trim() : "";
    if (!m || !e) return null;
    return { mailboxId: m, eventId: e };
  }
}
