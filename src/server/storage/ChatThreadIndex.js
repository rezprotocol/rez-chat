import { asInt, nonEmpty } from "./coerce.js";
import { coerceRow } from "../../records/domain/coerce.js";
import { ChatThreadIndexEntry, coercePreview } from "../../records/domain/ChatThreadIndexEntry.js";

const MAX_INDEX_SIZE = 500;
const INDEX_PREFIX = "app:threads:index/";
const INDEX_RECORD_PREFIX = "app:threads:indexRecord/";

function compareMessageKey(aAtMs, aMsgId, bAtMs, bMsgId) {
  const aAt = asInt(aAtMs, 0);
  const bAt = asInt(bAtMs, 0);
  if (aAt !== bAt) return aAt < bAt ? -1 : 1;
  const aId = String(aMsgId || "");
  const bId = String(bMsgId || "");
  const cmp = aId.localeCompare(bId);
  if (cmp < 0) return -1;
  if (cmp > 0) return 1;
  return 0;
}

function isKeyGreater(aAtMs, aMsgId, bAtMs, bMsgId) {
  return compareMessageKey(aAtMs, aMsgId, bAtMs, bMsgId) > 0;
}

function coerceIndexRecord(input, nowMs) {
  return coerceRow(ChatThreadIndexEntry, input, { seed: { updatedAtMs: nowMs }, label: "ChatThreadIndex" });
}

function emptyEntry(threadId, nowMs) {
  return new ChatThreadIndexEntry({ threadId, updatedAtMs: nowMs });
}

function withOverrides(existing, overrides) {
  return new ChatThreadIndexEntry({ ...existing.toJSON(), ...overrides });
}

// Lightweight "tip pointer" projection used for ordering the index list.
// Three fields; not a domain concept on its own — just a sort key.
function coerceTipPointer(input) {
  if (!input || typeof input !== "object") return null;
  const threadId = nonEmpty(input.threadId);
  if (!threadId) return null;
  return {
    threadId,
    lastActivityAtMs: asInt(input.lastActivityAtMs, 0),
    lastActivityMsgId: nonEmpty(input.lastActivityMsgId),
  };
}

function sortEntries(list) {
  list.sort((a, b) => {
    const keyCmp = compareMessageKey(
      (b && b.lastActivityAtMs != null) ? b.lastActivityAtMs : 0,
      (b && b.lastActivityMsgId) || "",
      (a && a.lastActivityAtMs != null) ? a.lastActivityAtMs : 0,
      (a && a.lastActivityMsgId) || "",
    );
    if (keyCmp !== 0) return keyCmp;
    return String((a && a.threadId) || "").localeCompare(String((b && b.threadId) || ""));
  });
}

// "#general" is the implicit bucket for messages with no channelId tag.
// Wire shape uses `""` so a single object covers named and implicit channels.
const GENERAL_CHANNEL_KEY = "";

function messageChannelKey(message) {
  if (!message || typeof message !== "object") return GENERAL_CHANNEL_KEY;
  const payload = message.payload;
  if (payload && typeof payload === "object" && typeof payload.channelId === "string") {
    const trimmed = payload.channelId.trim();
    if (trimmed) return trimmed;
  }
  return GENERAL_CHANNEL_KEY;
}

function unreadSummary({ messages, ownerAccountId, lastReadAtMs, lastReadMsgId, lastReadByChannelId = {} }) {
  const owner = nonEmpty(ownerAccountId);
  const candidates = [];
  const unreadByChannelId = {};
  const fallbackAtMs = (lastReadAtMs != null) ? lastReadAtMs : 0;
  const fallbackMsgId = lastReadMsgId || "";
  for (const message of messages) {
    const status = nonEmpty(message && message.status);
    if (status === "pending" || status === "failed") continue;
    const createdAtMs = asInt(message && message.createdAtMs, 0);
    const messageId = nonEmpty(message && message.messageId);
    if (!messageId) continue;
    const channelKey = messageChannelKey(message);
    // Per-channel marker wins; fall back to thread-level marker for any
    // channel that hasn't been individually read yet.
    const channelMarker = lastReadByChannelId && lastReadByChannelId[channelKey];
    const markerAtMs = channelMarker ? channelMarker.atMs : fallbackAtMs;
    const markerMsgId = channelMarker ? channelMarker.msgId : fallbackMsgId;
    if (!isKeyGreater(createdAtMs, messageId, markerAtMs, markerMsgId)) continue;
    const sender = nonEmpty(message && message.senderAccountId);
    if (owner && sender && sender === owner) continue;
    candidates.push({ createdAtMs, messageId });
    unreadByChannelId[channelKey] = (unreadByChannelId[channelKey] || 0) + 1;
  }
  candidates.sort((a, b) => compareMessageKey(a.createdAtMs, a.messageId, b.createdAtMs, b.messageId));
  const newest = candidates.length > 0 ? candidates[candidates.length - 1] : null;
  return {
    unreadCount: candidates.length,
    unreadByChannelId,
    lastUnreadCountedAtMs: (newest && newest.createdAtMs != null) ? newest.createdAtMs : (lastReadAtMs != null ? lastReadAtMs : null),
    lastUnreadCountedMsgId: (newest && newest.messageId) ? newest.messageId : (lastReadMsgId != null ? lastReadMsgId : null),
  };
}

export class ThreadIndexService {
  constructor({ storageProvider, ownerAccountId, threadStore, clock = () => Date.now() } = {}) {
    if (!storageProvider || typeof storageProvider.getKeyValueStore !== "function") {
      throw new Error("ThreadIndexService requires storageProvider.getKeyValueStore()");
    }
    if (typeof ownerAccountId !== "string" || !ownerAccountId.trim()) {
      throw new Error("ThreadIndexService requires ownerAccountId");
    }
    if (!threadStore || typeof threadStore.listMessages !== "function") {
      throw new Error("ThreadIndexService requires threadStore");
    }
    if (typeof clock !== "function") {
      throw new Error("ThreadIndexService requires clock function");
    }

    this._ownerAccountId = ownerAccountId.trim();
    this.kv = storageProvider.getKeyValueStore(this._ownerAccountId);
    this.clock = clock;
    this.threadStore = threadStore;
    this._writeChains = new Map();
  }

  _kIndex() {
    return `${INDEX_PREFIX}${this._ownerAccountId}`;
  }

  _kIndexRecord(threadId) {
    return `${INDEX_RECORD_PREFIX}${this._ownerAccountId}/${threadId}`;
  }

  async _loadIndex() {
    const raw = await this.kv.get(this._kIndex());
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const row of raw) {
      const item = coerceTipPointer(row);
      if (item) out.push(item);
    }
    sortEntries(out);
    return out;
  }

  async _saveIndex(list) {
    const next = Array.isArray(list) ? list.slice(0, MAX_INDEX_SIZE) : [];
    await this.kv.set(this._kIndex(), next);
  }

  async _saveRecord(record) {
    await this.kv.set(this._kIndexRecord(record.threadId), record.toJSON());
    const index = await this._loadIndex();
    const row = {
      threadId: record.threadId,
      lastActivityAtMs: asInt(record.lastActivityAtMs, 0),
      lastActivityMsgId: nonEmpty(record.lastActivityMsgId),
    };
    const at = index.findIndex((entry) => entry.threadId === row.threadId);
    if (at >= 0) index[at] = row;
    else index.push(row);
    sortEntries(index);
    await this._saveIndex(index);
  }

  _withWriteLock(threadId, operation) {
    const id = nonEmpty(threadId) || "_global";
    const lockId = `${this._ownerAccountId}|${id}`;
    const previous = this._writeChains.get(lockId) || Promise.resolve();
    const run = previous.catch((err) => { console.error("[ChatThreadIndex] prior write-chain step failed", err); }).then(() => operation());
    const next = run.finally(() => {
      if (this._writeChains.get(lockId) === next) {
        this._writeChains.delete(lockId);
      }
    });
    this._writeChains.set(lockId, next);
    return next;
  }

  async removeThread({ threadId } = {}) {
    const id = nonEmpty(threadId);
    if (!id) throw new Error("ThreadIndexService.removeThread requires threadId");
    return this._withWriteLock(id, async () => {
      await this.kv.delete(this._kIndexRecord(id));
      const index = await this._loadIndex();
      const next = index.filter((entry) => entry.threadId !== id);
      await this._saveIndex(next);
      return true;
    });
  }

  async getIndexRecord({ threadId } = {}) {
    const id = nonEmpty(threadId);
    if (!id) return null;
    const now = asInt(this.clock(), Date.now());
    return coerceIndexRecord(await this.kv.get(this._kIndexRecord(id)), now);
  }

  async listThreadIndex({ limit = 50 } = {}) {
    const max = Math.max(1, Math.min(MAX_INDEX_SIZE, asInt(limit, 50)));
    const now = asInt(this.clock(), Date.now());
    const entries = (await this._loadIndex()).slice(0, max);
    const threads = [];
    for (const entry of entries) {
      const record = coerceIndexRecord(await this.kv.get(this._kIndexRecord(entry.threadId)), now);
      if (record) threads.push(record);
    }
    return { threads };
  }

  async listThreads({ limit = 50 } = {}) {
    return this.listThreadIndex({ limit });
  }

  async ensureThreadSummary({ threadId } = {}) {
    const id = nonEmpty(threadId);
    if (!id) {
      throw new Error("ThreadIndexService.ensureThreadSummary requires threadId");
    }

    return this._withWriteLock(id, async () => {
      const now = asInt(this.clock(), Date.now());
      const existing = (await this.getIndexRecord({ threadId: id })) || emptyEntry(id, now);

      const messagePage = await this.threadStore.listMessages({ threadId: id, limit: MAX_INDEX_SIZE });
      const items = messagePage && Array.isArray(messagePage.items) ? messagePage.items : [];
      if (items.length === 0) {
        if (!existing.lastActivityMsgId && existing.updatedAtMs !== now) {
          const next = withOverrides(existing, { updatedAtMs: now });
          await this._saveRecord(next);
          return next;
        }
        return existing;
      }

      const latest = items[0];
      const latestCreatedAt = asInt(latest && latest.createdAtMs, 0);
      const latestMessageId = nonEmpty(latest && latest.messageId);
      const latestPreview = coercePreview(
        latest && typeof latest.text === "string"
          ? latest.text
          : latest && typeof latest.preview === "string"
            ? latest.preview
            : ""
      );
      const unread = unreadSummary({
        messages: items,
        ownerAccountId: this._ownerAccountId,
        lastReadAtMs: existing.lastReadAtMs,
        lastReadMsgId: existing.lastReadMsgId,
        lastReadByChannelId: existing.lastReadByChannelId,
      });

      const next = withOverrides(existing, {
        updatedAtMs: now,
        lastActivityAtMs: latestCreatedAt || existing.lastActivityAtMs,
        lastActivityMsgId: latestMessageId || existing.lastActivityMsgId,
        lastMessagePreview: latestPreview || existing.lastMessagePreview,
        previewAtMs: latestPreview ? latestCreatedAt : existing.previewAtMs,
        previewMsgId: latestPreview ? latestMessageId : existing.previewMsgId,
        unreadCount: unread.unreadCount,
        unreadByChannelId: unread.unreadByChannelId,
        lastUnreadCountedAtMs: unread.lastUnreadCountedAtMs,
        lastUnreadCountedMsgId: unread.lastUnreadCountedMsgId,
      });
      await this._saveRecord(next);
      return next;
    });
  }

  async markThreadRead({ threadId } = {}) {
    const id = nonEmpty(threadId);
    if (!id) throw new Error("ThreadIndexService.markThreadRead requires threadId");
    return this._withWriteLock(id, async () => {
      const now = asInt(this.clock(), Date.now());
      const existing = (await this.getIndexRecord({ threadId: id })) || emptyEntry(id, now);

      const messagePage = await this.threadStore.listMessages({ threadId: id, limit: MAX_INDEX_SIZE });
      const latest = (messagePage.items && messagePage.items[0]) || null;
      const latestCreatedAt = latest ? asInt(latest.createdAtMs, 0) : null;
      const latestMessageId = latest ? nonEmpty(latest.messageId) : null;

      const next = withOverrides(existing, {
        updatedAtMs: now,
        unreadCount: 0,
        unreadByChannelId: {},
        // Thread-wide mark-read supersedes any per-channel cursors; clear
        // them so the (lower) thread-level marker is the single source of
        // truth going forward.
        lastReadByChannelId: {},
        lastReadAtMs: latestCreatedAt,
        lastReadMsgId: latestMessageId,
        lastUnreadCountedAtMs: latestCreatedAt,
        lastUnreadCountedMsgId: latestMessageId,
      });
      await this._saveRecord(next);
      return next;
    });
  }

  async markChannelRead({ threadId, channelId } = {}) {
    const id = nonEmpty(threadId);
    if (!id) throw new Error("ThreadIndexService.markChannelRead requires threadId");
    const channelKey = typeof channelId === "string" ? channelId.trim() : "";
    return this._withWriteLock(id, async () => {
      const now = asInt(this.clock(), Date.now());
      const existing = (await this.getIndexRecord({ threadId: id })) || emptyEntry(id, now);

      const messagePage = await this.threadStore.listMessages({ threadId: id, limit: MAX_INDEX_SIZE });
      const items = messagePage && Array.isArray(messagePage.items) ? messagePage.items : [];

      // Find the latest message in the target channel so the cursor advances
      // past anything currently visible there. An empty bucket sets no
      // cursor — nothing to "have read" yet.
      let latestAtMs = 0;
      let latestMsgId = "";
      for (const msg of items) {
        if (messageChannelKey(msg) !== channelKey) continue;
        const atMs = asInt(msg && msg.createdAtMs, 0);
        const msgId = nonEmpty(msg && msg.messageId);
        if (!msgId) continue;
        if (isKeyGreater(atMs, msgId, latestAtMs, latestMsgId)) {
          latestAtMs = atMs;
          latestMsgId = msgId;
        }
      }

      const nextByChannel = { ...(existing.lastReadByChannelId || {}) };
      if (latestMsgId) {
        nextByChannel[channelKey] = { atMs: latestAtMs, msgId: latestMsgId };
      }

      const unread = unreadSummary({
        messages: items,
        ownerAccountId: this._ownerAccountId,
        lastReadAtMs: existing.lastReadAtMs,
        lastReadMsgId: existing.lastReadMsgId,
        lastReadByChannelId: nextByChannel,
      });

      const next = withOverrides(existing, {
        updatedAtMs: now,
        unreadCount: unread.unreadCount,
        unreadByChannelId: unread.unreadByChannelId,
        lastReadByChannelId: nextByChannel,
        lastUnreadCountedAtMs: unread.lastUnreadCountedAtMs,
        lastUnreadCountedMsgId: unread.lastUnreadCountedMsgId,
      });
      await this._saveRecord(next);
      return next;
    });
  }

  async upsertOnMessageAccepted({
    threadId,
    messageId,
    createdAtMs,
    senderAccountId = null,
    preview = null,
  } = {}) {
    const id = nonEmpty(threadId);
    const msgId = nonEmpty(messageId);
    if (!id || !msgId) {
      throw new Error("ThreadIndexService.upsertOnMessageAccepted requires threadId/messageId");
    }

    return this._withWriteLock(id, async () => {
      const now = asInt(this.clock(), Date.now());
      const atMs = asInt(createdAtMs, now);
      const previewText = coercePreview(preview);
      const existing = (await this.getIndexRecord({ threadId: id })) || emptyEntry(id, now);

      const activityIsNewer = isKeyGreater(
        atMs,
        msgId,
        existing.lastActivityAtMs,
        existing.lastActivityMsgId || "",
      );
      const previewIsNewer = previewText && isKeyGreater(
        atMs,
        msgId,
        existing.previewAtMs == null ? 0 : existing.previewAtMs,
        existing.previewMsgId || "",
      );

      const page = await this.threadStore.listMessages({ threadId: id, limit: MAX_INDEX_SIZE });
      const persisted = Array.isArray(page.items) ? page.items : [];
      const merged = [];
      const seen = new Set();
      const fallbackSenderAccountId = nonEmpty(senderAccountId);
      for (const message of persisted) {
        const mid = nonEmpty(message && message.messageId);
        if (!mid || seen.has(mid)) continue;
        seen.add(mid);
        if (mid === msgId && fallbackSenderAccountId && !nonEmpty(message && message.senderAccountId)) {
          merged.push({
            ...message,
            senderAccountId: fallbackSenderAccountId,
          });
          continue;
        }
        merged.push(message);
      }
      if (!seen.has(msgId)) {
        merged.push({
          messageId: msgId,
          createdAtMs: atMs,
          senderAccountId: nonEmpty(senderAccountId),
        });
      }

      const unread = unreadSummary({
        messages: merged,
        ownerAccountId: this._ownerAccountId,
        lastReadAtMs: existing.lastReadAtMs,
        lastReadMsgId: existing.lastReadMsgId,
        lastReadByChannelId: existing.lastReadByChannelId,
      });

      const next = withOverrides(existing, {
        updatedAtMs: now,
        lastActivityAtMs: activityIsNewer ? atMs : existing.lastActivityAtMs,
        lastActivityMsgId: activityIsNewer ? msgId : existing.lastActivityMsgId,
        lastMessagePreview: previewIsNewer ? previewText : existing.lastMessagePreview,
        previewAtMs: previewIsNewer ? atMs : existing.previewAtMs,
        previewMsgId: previewIsNewer ? msgId : existing.previewMsgId,
        unreadCount: unread.unreadCount,
        unreadByChannelId: unread.unreadByChannelId,
        lastUnreadCountedAtMs: unread.lastUnreadCountedAtMs,
        lastUnreadCountedMsgId: unread.lastUnreadCountedMsgId,
      });

      await this._saveRecord(next);
      return next;
    });
  }

  async upsertFromMessage({ threadId, messageId, ts, preview = null, senderAccountId = null } = {}) {
    const id = nonEmpty(threadId);
    if (!id) throw new Error("ThreadIndexService.upsertFromMessage requires threadId");
    const atMs = asInt(ts, asInt(this.clock(), Date.now()));
    const msgId = nonEmpty(messageId);
    if (msgId) {
      return this.upsertOnMessageAccepted({
        threadId: id,
        messageId: msgId,
        createdAtMs: atMs,
        senderAccountId: nonEmpty(senderAccountId),
        preview,
      });
    }

    return this._withWriteLock(id, async () => {
      const now = asInt(this.clock(), Date.now());
      const existing = (await this.getIndexRecord({ threadId: id })) || emptyEntry(id, now);
      const syntheticMsgId = `sys:${atMs}:${id}`;
      const activityIsNewer = isKeyGreater(
        atMs,
        syntheticMsgId,
        existing.lastActivityAtMs,
        existing.lastActivityMsgId || "",
      );
      const previewText = coercePreview(preview);
      const previewIsNewer = previewText && isKeyGreater(
        atMs,
        syntheticMsgId,
        existing.previewAtMs == null ? 0 : existing.previewAtMs,
        existing.previewMsgId || "",
      );
      const next = withOverrides(existing, {
        updatedAtMs: now,
        lastActivityAtMs: activityIsNewer ? atMs : existing.lastActivityAtMs,
        lastActivityMsgId: activityIsNewer ? syntheticMsgId : existing.lastActivityMsgId,
        lastMessagePreview: previewIsNewer ? previewText : existing.lastMessagePreview,
        previewAtMs: previewIsNewer ? atMs : existing.previewAtMs,
        previewMsgId: previewIsNewer ? syntheticMsgId : existing.previewMsgId,
      });
      await this._saveRecord(next);
      return next;
    });
  }
}
