const KEY_PREFIX = "chat-server:inbox:processed:v1:";

/**
 * Per-(mailbox,event) "already decrypted + consumed" marker for the inbound
 * deposit pipeline.
 *
 * Why this exists: a deposit can be delivered TWICE to the chat-server — once
 * live via the SDK push (MailboxPushBridge) and again by the catch-up drain
 * (InboxCatchupService) on a later cold boot, because the push path does NOT
 * advance the catch-up cursor. Re-running the SECOND copy through the peer-link
 * decrypt is NOT a harmless "redundant decode" (as the cursor's crash-semantics
 * note once assumed): the double ratchet has already advanced past that
 * ciphertext, so the re-decrypt fails with an AES-GCM auth error. That dropped
 * the genuinely-new offline message that followed it. Marking each eventId as
 * processed AFTER a successful decrypt lets the pipeline skip the re-decrypt.
 *
 * Bounded by pruning: InboxCatchupService.forget()s each marker right after it
 * advances the persisted cursor past that eventId — once an event is at/below
 * the high-water mark it is never re-fetched, so the marker is redundant. The
 * live set is therefore only "events consumed via push since the last drain",
 * reclaimed on every drain. Backed by the chat-server's global KV
 * (`getKeyValueStore(null)`), same scope as the catch-up cursor.
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

  #ids(mailboxId, eventId) {
    const m = typeof mailboxId === "string" ? mailboxId.trim() : "";
    const e = typeof eventId === "string" ? eventId.trim() : "";
    if (!m || !e) return null;
    return { mailboxId: m, eventId: e };
  }
}
