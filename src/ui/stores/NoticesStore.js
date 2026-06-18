import { StoreBase } from "./StoreBase.js";

// Stable, home-independent id for a quarantine notice. Durable-mode deposits
// carry a per-inbox `seq`; legacy deposits carry a home-local `eventId`. Mirror
// the InboundDepositPipeline dedup key so the same dropped deposit never
// surfaces twice.
function noticeIdFor(event) {
  const mailboxId = event && typeof event.mailboxId === "string" ? event.mailboxId.trim() : "";
  if (!mailboxId) return "";
  const seq = event && Number.isInteger(event.seq) && event.seq >= 0 ? event.seq : null;
  const eventId = event && typeof event.eventId === "string" ? event.eventId.trim() : "";
  if (seq != null) return mailboxId + "/s" + seq;
  if (eventId) return mailboxId + "/e" + eventId;
  return "";
}

// UI-only store of quarantine notices (undeliverable deposits the runtime had to
// drop). Append-only within a session; entries are never mutated or removed, so
// "unread" is just (size − acknowledged). Holds the raw event record as truth —
// no derived copy — alongside the local arrival time for ordering/display.
export class NoticesStore extends StoreBase {
  #notices;   // Map<id, { id, event, receivedAtMs }>
  #readCount; // count of notices the user has acknowledged (oldest-first)

  constructor({ bus = null } = {}) {
    super({ storeName: "notices", defaultSource: "NoticesStore", bus });
    this.#notices = new Map();
    this.#readCount = 0;
  }

  addNotice(event, receivedAtMs) {
    const id = noticeIdFor(event);
    if (!id) return null;
    const existing = this.#notices.get(id);
    if (existing) return existing;
    const ts = Number.isFinite(receivedAtMs) ? receivedAtMs : Date.now();
    const entry = { id, event, receivedAtMs: ts };
    this.#notices.set(id, entry);
    this._emit("notices.added", { id });
    return entry;
  }

  getNotices() {
    return [...this.#notices.values()].sort((a, b) => {
      if (a.receivedAtMs !== b.receivedAtMs) return a.receivedAtMs - b.receivedAtMs;
      return a.id.localeCompare(b.id);
    });
  }

  getNotice(id) {
    const key = String(id == null ? "" : id).trim();
    if (!key) return null;
    return this.#notices.get(key) || null;
  }

  size() {
    return this.#notices.size;
  }

  latest() {
    const all = this.getNotices();
    return all.length > 0 ? all[all.length - 1] : null;
  }

  unreadCount() {
    return Math.max(0, this.#notices.size - this.#readCount);
  }

  markRead() {
    if (this.#readCount >= this.#notices.size) return;
    this.#readCount = this.#notices.size;
    this._emit("notices.read");
  }

  reset() {
    this.#notices.clear();
    this.#readCount = 0;
    this._emit("notices.reset");
  }
}
