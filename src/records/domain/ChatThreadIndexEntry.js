import { RRecord } from "@rezprotocol/sdk/client";
import { nonEmptyString, toFiniteNumber } from "./coerce.js";

const MAX_PREVIEW_LENGTH = 120;

export function coercePreview(value) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  return text.length <= MAX_PREVIEW_LENGTH ? text : text.slice(0, MAX_PREVIEW_LENGTH);
}

// Per-channel unread breakdown for a thread. Channels with 0 unread are
// omitted; the "#general" bucket is keyed `""` (matching wire shape). Sum
// of values equals the thread's top-level `unreadCount`.
export function coerceUnreadByChannelId(value) {
  const out = {};
  if (!value || typeof value !== "object") return out;
  for (const key of Object.keys(value)) {
    const channelId = String(key == null ? "" : key);
    const count = Math.max(0, Math.trunc(toFiniteNumber(value[key], 0)));
    if (count > 0) out[channelId] = count;
  }
  return out;
}

// Per-channel last-read cursors. Each value is { atMs: int, msgId: string }
// pointing at the most recent message considered "read" for that channel.
// The "#general" bucket is keyed `""`. If a channel has no entry here,
// unread calculation falls back to the thread-level lastReadAtMs/MsgId.
export function coerceLastReadByChannelId(value) {
  const out = {};
  if (!value || typeof value !== "object") return out;
  for (const key of Object.keys(value)) {
    const channelId = String(key == null ? "" : key);
    const raw = value[key];
    if (!raw || typeof raw !== "object") continue;
    const atMs = Math.max(0, Math.trunc(toFiniteNumber(raw.atMs, 0)));
    const msgId = typeof raw.msgId === "string" ? raw.msgId.trim() : "";
    if (atMs === 0 && !msgId) continue;
    out[channelId] = { atMs, msgId };
  }
  return out;
}

/**
 * ChatThreadIndexEntry: the per-thread row stored in the threads-index KV.
 * Carries the "most recent activity" pointer plus the unread/last-read
 * cursors. Constructed once and frozen; updates produce new instances.
 */
export class ChatThreadIndexEntry extends RRecord {
  static type = "chat.threadIndexEntry";

  constructor(raw = {}) {
    super();
    this.threadId = nonEmptyString(raw.threadId);
    this.lastActivityAtMs = toFiniteNumber(raw.lastActivityAtMs, 0);
    this.lastActivityMsgId = nonEmptyString(raw.lastActivityMsgId);
    this.lastMessagePreview = coercePreview(raw.lastMessagePreview);
    this.unreadCount = Math.max(0, Math.trunc(toFiniteNumber(raw.unreadCount, 0)));
    this.unreadByChannelId = coerceUnreadByChannelId(raw.unreadByChannelId);
    this.lastReadByChannelId = coerceLastReadByChannelId(raw.lastReadByChannelId);
    this.updatedAtMs = toFiniteNumber(raw.updatedAtMs, this.lastActivityAtMs || 0);
    this.lastReadAtMs = raw.lastReadAtMs == null ? null : toFiniteNumber(raw.lastReadAtMs, 0);
    this.lastReadMsgId = nonEmptyString(raw.lastReadMsgId);
    this.lastUnreadCountedAtMs = raw.lastUnreadCountedAtMs == null
      ? null
      : toFiniteNumber(raw.lastUnreadCountedAtMs, 0);
    this.lastUnreadCountedMsgId = nonEmptyString(raw.lastUnreadCountedMsgId);
    this.previewAtMs = raw.previewAtMs == null ? null : toFiniteNumber(raw.previewAtMs, 0);
    this.previewMsgId = nonEmptyString(raw.previewMsgId);
    this._seal();
  }

  validate() {
    this.assert(this.threadId.length > 0, "ChatThreadIndexEntry requires threadId");
  }
}
