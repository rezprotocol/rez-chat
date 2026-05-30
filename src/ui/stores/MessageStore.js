import { StoreBase } from "./StoreBase.js";
import { ChatMessage, nonEmptyString } from "../../records/index.js";
import { SYSTEM_EVENT_KIND } from "../../records/payloads/ChatSystemEventPayloadV1.js";

function compareMessages(a, b) {
  const at = Number(a && a.createdAtMs || 0);
  const bt = Number(b && b.createdAtMs || 0);
  if (at !== bt) return at - bt;
  return nonEmptyString(a && a.messageId).localeCompare(nonEmptyString(b && b.messageId));
}

function asRecord(threadId, value) {
  if (value instanceof ChatMessage) {
    if (value.threadId === threadId) return value;
    return new ChatMessage({ ...value.toJSON(), threadId });
  }
  // Untrusted input boundary: UI bus delivers plain objects from wire
  // events. Catch + drop on malformed input; the store keeps going.
  const raw = value && typeof value === "object" ? value : {};
  try {
    return new ChatMessage({ ...raw, threadId });
  } catch {
    return null;
  }
}

export class MessageStore extends StoreBase {
  #messagesByThreadId;
  #loadedByThreadId;

  constructor({ bus = null } = {}) {
    super({ storeName: "messages", defaultSource: "MessageStore", bus });
    this.#messagesByThreadId = new Map();
    this.#loadedByThreadId = new Map();
  }

  reset() {
    this.#messagesByThreadId.clear();
    this.#loadedByThreadId.clear();
    this._emit("messages.reset");
  }

  isLoaded(threadId) {
    const id = nonEmptyString(threadId);
    if (!id) return false;
    return this.#loadedByThreadId.get(id) === true;
  }

  markLoaded(threadId, loaded = true) {
    const id = nonEmptyString(threadId);
    if (!id) return;
    this.#loadedByThreadId.set(id, loaded === true);
  }

  getMessages(threadId) {
    const id = nonEmptyString(threadId);
    if (!id) return [];
    return [...(this.#messagesByThreadId.get(id) || [])].sort(compareMessages);
  }

  getMessageIds(threadId) {
    return this.getMessages(threadId).map((msg) => msg.messageId);
  }

  getMessage(threadId, messageId) {
    const tid = nonEmptyString(threadId);
    const mid = nonEmptyString(messageId);
    if (!tid || !mid) return null;
    const list = this.#messagesByThreadId.get(tid) || [];
    for (const row of list) {
      if (row.messageId === mid) return row;
    }
    return null;
  }

  getLastMessage(threadId) {
    const list = this.getMessages(threadId);
    return list.length > 0 ? list[list.length - 1] : null;
  }

  replaceMessages(threadId, messages = []) {
    const id = nonEmptyString(threadId);
    if (!id) return;
    const next = [];
    for (const raw of Array.isArray(messages) ? messages : []) {
      const record = asRecord(id, raw);
      if (!record || !record.messageId) continue;
      next.push(record);
    }
    next.sort(compareMessages);
    this.#messagesByThreadId.set(id, next);
    this.#loadedByThreadId.set(id, true);
    this._emit("messages.replaced", { threadId: id });
  }

  upsertMessage(threadId, message) {
    const id = nonEmptyString(threadId || (message && message.threadId));
    if (!id) return;
    const record = asRecord(id, message);
    if (!record || !record.messageId) return;
    const current = this.#messagesByThreadId.get(id) || [];
    const next = [];
    let found = false;
    for (const row of current) {
      if (row.messageId === record.messageId) {
        next.push(record);
        found = true;
      } else {
        next.push(row);
      }
    }
    if (!found) next.push(record);
    next.sort(compareMessages);
    this.#messagesByThreadId.set(id, next);
    this._emit("messages.upserted", { threadId: id, messageId: record.messageId });
  }

  updateStatus(threadId, messageId, patch = {}) {
    const current = this.getMessage(threadId, messageId);
    if (!current) return;
    this.upsertMessage(threadId, new ChatMessage({
      ...current.toJSON(),
      ...(patch && typeof patch === "object" ? patch : {}),
    }));
  }

  removeMessage(threadId, messageId) {
    const tid = nonEmptyString(threadId);
    const mid = nonEmptyString(messageId);
    if (!tid || !mid) return;
    const current = this.#messagesByThreadId.get(tid);
    if (!current || current.length === 0) return;
    const next = current.filter((row) => row.messageId !== mid);
    if (next.length === current.length) return;
    this.#messagesByThreadId.set(tid, next);
    this._emit("messages.removed", { threadId: tid, messageId: mid });
  }

  forgetThread(threadId) {
    const id = nonEmptyString(threadId);
    if (!id) return;
    this.#messagesByThreadId.delete(id);
    this.#loadedByThreadId.delete(id);
  }

  // ---- Own-data accessors ------------------------------------------------

  // Channel-filtered timeline. System events bypass the channel filter
  // (they belong to the whole thread, e.g. "X joined the group").
  // The canonical general-channel id is GENERAL_CHANNEL_ID ("") — any
  // null/undefined/"" caller request and any message with no payload
  // channelId resolve to that bucket. Matching is strict string equality
  // against the trimmed payload value, identical to MessageTimelineView.
  getMessagesFor(threadId, channelId) {
    const all = this.getMessages(threadId);
    if (all.length === 0) return all;
    const target = String(channelId == null ? "" : channelId).trim();
    const out = [];
    for (const m of all) {
      if (isSystemMessage(m)) {
        out.push(m);
        continue;
      }
      if (messageChannelId(m) === target) out.push(m);
    }
    return out;
  }
}

function messageChannelId(message) {
  if (!message) return "";
  const payload = message.payload;
  if (payload && typeof payload === "object" && typeof payload.channelId === "string") {
    return payload.channelId.trim();
  }
  return "";
}

function isSystemMessage(message) {
  if (!message) return false;
  const payload = message.payload;
  if (!payload || typeof payload !== "object") return false;
  return payload.kind === SYSTEM_EVENT_KIND;
}
