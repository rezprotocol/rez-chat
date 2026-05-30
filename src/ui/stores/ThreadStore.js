import { StoreBase } from "./StoreBase.js";
import { ChatThread, nonEmptyString } from "../../records/index.js";

function compareThreads(a, b) {
  const at = Number(a && a.lastActivityAtMs || 0);
  const bt = Number(b && b.lastActivityAtMs || 0);
  if (at !== bt) return bt - at;
  const am = nonEmptyString(a && a.lastActivityMsgId);
  const bm = nonEmptyString(b && b.lastActivityMsgId);
  if (am !== bm) return bm.localeCompare(am);
  return nonEmptyString(a && a.threadId).localeCompare(nonEmptyString(b && b.threadId));
}

function asRecord(value) {
  if (value instanceof ChatThread) return value;
  // UI bus boundary: bus payloads can be plain objects from transports
  // that deserialized JSON. Catch+log+drop on malformed input.
  try {
    return new ChatThread(value);
  } catch (err) {
    console.warn("[ThreadStore] dropped malformed thread row:", err && err.message ? err.message : err);
    return null;
  }
}

export class ThreadStore extends StoreBase {
  #threads;
  #loaded;

  constructor({ bus = null } = {}) {
    super({ storeName: "threads", defaultSource: "ThreadStore", bus });
    this.#threads = new Map();
    this.#loaded = false;
  }

  reset() {
    this.#threads.clear();
    this.#loaded = false;
    this._emit("threads.reset");
  }

  isLoaded() {
    return this.#loaded === true;
  }

  markLoaded(loaded = true) {
    this.#loaded = loaded === true;
  }

  getThreads() {
    return [...this.#threads.values()].sort(compareThreads);
  }

  getThreadIds() {
    return this.getThreads().map((thread) => thread.threadId);
  }

  getThread(threadId) {
    const id = nonEmptyString(threadId);
    if (!id) return null;
    return this.#threads.get(id) || null;
  }

  getThreadByGroupId(groupId) {
    const target = nonEmptyString(groupId);
    if (!target) return null;
    for (const thread of this.#threads.values()) {
      if (thread && thread.groupId === target) return thread;
    }
    return null;
  }

  replaceThreads(threads = []) {
    this.#threads.clear();
    for (const raw of Array.isArray(threads) ? threads : []) {
      const record = asRecord(raw);
      if (!record || !record.threadId) continue;
      this.#threads.set(record.threadId, record);
    }
    this.#loaded = true;
    this._emit("threads.replaced");
  }

  upsertThread(thread) {
    const record = asRecord(thread);
    if (!record || !record.threadId) return;
    this.#threads.set(record.threadId, record);
    this._emit("threads.upserted", { threadId: record.threadId });
  }

  removeThread(threadId) {
    const id = nonEmptyString(threadId);
    if (!id) return;
    if (!this.#threads.delete(id)) return;
    this._emit("threads.removed", { threadId: id });
  }

  patchThread(threadId, patch = {}) {
    const current = this.getThread(threadId);
    if (!current) return;
    this.upsertThread(new ChatThread({
      ...current.toJSON(),
      ...(patch && typeof patch === "object" ? patch : {}),
    }));
  }

  // ---- Own-data accessors ------------------------------------------------
  // Anything requiring a peer store lives in src/ui/queries/threadQueries.js.

  // Unread count for a (thread, channel). SSOT is `thread.unreadByChannelId`
  // (maintained server-side and mirrored by ThreadsService). Falls back to
  // `thread.unreadCount` for the general bucket when no per-channel entry
  // exists. Pure own-data lookup — no other store consulted.
  unreadCountFor(threadId, channelId) {
    const thread = this.getThread(threadId);
    if (!thread) return 0;
    const cid = String(channelId == null ? "" : channelId).trim();
    const byChannel = thread.unreadByChannelId;
    if (byChannel && typeof byChannel === "object" && byChannel[cid] != null) {
      return Math.max(0, Number(byChannel[cid]) || 0);
    }
    if (!cid) return Math.max(0, Number(thread.unreadCount) || 0);
    return 0;
  }
}
