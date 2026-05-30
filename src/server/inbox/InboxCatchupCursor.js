const KEY_PREFIX = "chat-server:inbox:catchup-cursor:v1:";

/**
 * Persistent per-inbox high-water-mark for the InboxCatchupService.
 *
 * Backed by the chat-server's global encrypted KV (same scope as
 * InboxClaimant's `chat-server:inbox:primary:v1` key — `getKeyValueStore(null)`).
 * The cursor value is the eventId of the last mailbox event the
 * chat-server has dispatched to its bus subscribers. Subsequent
 * `sdk.mailbox.list({ mailboxId, cursor })` calls return only events
 * strictly after this id (see rez-core RMailbox.list semantics).
 *
 * Crash semantics: cursor is advanced AFTER the bus dispatch resolves.
 * If the process dies mid-dispatch, the same event is redispatched on
 * next start; downstream persistence is canonical-key idempotent so the
 * worst case is a redundant decrypt/decode pass.
 */
export class InboxCatchupCursor {
  #kvStore;

  constructor({ kvStore } = {}) {
    if (!kvStore || typeof kvStore.get !== "function" || typeof kvStore.set !== "function") {
      throw new Error("InboxCatchupCursor requires kvStore with get/set");
    }
    this.#kvStore = kvStore;
  }

  async read(mailboxId) {
    const id = nonEmpty(mailboxId, "mailboxId");
    const stored = await this.#kvStore.get(KEY_PREFIX + id);
    if (stored == null) return null;
    if (typeof stored === "string") return stored.length > 0 ? stored : null;
    if (typeof stored === "object" && typeof stored.lastEventId === "string") {
      return stored.lastEventId.length > 0 ? stored.lastEventId : null;
    }
    return null;
  }

  async write(mailboxId, lastEventId, { nowMs = Date.now() } = {}) {
    const id = nonEmpty(mailboxId, "mailboxId");
    const evt = nonEmpty(lastEventId, "lastEventId");
    await this.#kvStore.set(KEY_PREFIX + id, {
      inboxId: id,
      lastEventId: evt,
      lastUpdatedAtMs: Number.isFinite(nowMs) ? Number(nowMs) : Date.now(),
    });
  }
}

function nonEmpty(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("InboxCatchupCursor requires non-empty " + label);
  }
  return value.trim();
}
