import { Hash } from "@rezprotocol/sdk/hash";
import { asInt, nonEmpty } from "./coerce.js";
import { coerceRow } from "../../records/domain/coerce.js";
import { ChatMessage, MESSAGE_STATUSES, coerceReactions } from "../../records/domain/ChatMessage.js";
import { ChatThread, THREAD_TYPES, coerceThreadType } from "../../records/domain/ChatThread.js";
import { PENDING_MUTATION_KINDS, PendingMutation } from "../../records/domain/PendingMutation.js";
import { MESSAGE_KIND } from "../../records/payloads/ChatMessagePayloadV1.js";

// Re-export THREAD_TYPES for legacy importers (server services, tests).
// New code should import directly from records/domain/ChatThread.js.
export { THREAD_TYPES };

const THREAD_PREFIX = "app:threads/";
const MESSAGE_PREFIX = "app:messages/";
const IDEMPOTENCY_PREFIX = "app:idempotency/";
const PENDING_MUTATIONS_PREFIX = "app:pending_mutations/";
// AE-1 immutable OriginalMessage fact log (fingerprint-keyed, append-only)
// plus its base-kind (senderAccountId, messageId) → fingerprints index.
const ORIGINALS_PREFIX = "app:originals/";
const ORIGINALS_INDEX_PREFIX = "app:originals_index/";
// MessageCommitAck (plans/MESSAGE_COMMIT_ACK_PLAN.md §3, decision 4): the
// DURABLE pending-commit rows for signed 1:1 sends — retry eligibility
// derives from these rows + now, never from an in-memory timer, so a sender
// restart resumes the loop deterministically. Cleared only by a VERIFIED
// commit ack for the row's exact fingerprint.
const COMMIT_PENDING_PREFIX = "app:commit_pending/";
const MAX_MESSAGES_PER_THREAD = 500;
const MAX_PENDING_MUTATIONS_PER_TARGET = 64;
const PENDING_MUTATION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const VALID_MESSAGE_STATUSES = MESSAGE_STATUSES;

function isReadyForMessaging(thread) {
  if (!thread || typeof thread !== "object") return false;
  const threadType = coerceThreadType(thread.threadType || (thread.groupId ? "group" : "direct"));
  if (threadType === THREAD_TYPES.GROUP) return true;
  return !!nonEmpty(thread.peerAccountId) && !!nonEmpty(thread.peerInboxId);
}

function compareNewestFirst(a, b) {
  const aCreated = asInt(a && a.createdAtMs, 0);
  const bCreated = asInt(b && b.createdAtMs, 0);
  if (aCreated !== bCreated) return bCreated - aCreated;
  return String(b && b.messageId || "").localeCompare(String(a && a.messageId || ""));
}

function isStrictlyBeforeCursor(message, cursor) {
  if (!cursor) return true;
  const messageCreated = asInt(message && message.createdAtMs, 0);
  const cursorCreated = asInt(cursor && cursor.createdAtMs, 0);
  if (messageCreated < cursorCreated) return true;
  if (messageCreated > cursorCreated) return false;
  const messageId = String(message && message.messageId || "");
  const cursorId = String(cursor && cursor.messageId || "");
  return messageId.localeCompare(cursorId) < 0;
}

function statusRank(status) {
  switch (String(status || "").trim()) {
    case "delivered":
      return 5;
    case "sent":
      return 4;
    case "queued":
      return 3;
    case "pending":
      return 2;
    case "failed":
      return 1;
    default:
      return 0;
  }
}

function isPendingLikeMessageId(messageId) {
  const id = String(messageId || "").trim();
  return id.startsWith("pending:");
}

function mergeMessageForRead(primary, secondary) {
  const pText = primary && typeof primary.text === "string" ? primary.text : "";
  const sText = secondary && typeof secondary.text === "string" ? secondary.text : "";
  const pPayload = primary && primary.payload && typeof primary.payload === "object" ? primary.payload : null;
  const sPayload = secondary && secondary.payload && typeof secondary.payload === "object" ? secondary.payload : null;
  return {
    ...primary,
    senderAccountId: nonEmpty(primary && primary.senderAccountId) || nonEmpty(secondary && secondary.senderAccountId),
    packetB64: nonEmpty(primary && primary.packetB64) || nonEmpty(secondary && secondary.packetB64) || "",
    text: pText || sText || "",
    payload: pPayload || sPayload || null,
  };
}

function choosePreferredMessageForRead(a, b) {
  const aRank = statusRank(a && a.status);
  const bRank = statusRank(b && b.status);
  if (aRank !== bRank) {
    return aRank > bRank ? mergeMessageForRead(a, b) : mergeMessageForRead(b, a);
  }

  const aPendingId = isPendingLikeMessageId(a && a.messageId);
  const bPendingId = isPendingLikeMessageId(b && b.messageId);
  if (aPendingId !== bPendingId) {
    return aPendingId ? mergeMessageForRead(b, a) : mergeMessageForRead(a, b);
  }

  const aAccepted = asInt(a && a.acceptedAtMs, 0);
  const bAccepted = asInt(b && b.acceptedAtMs, 0);
  if (aAccepted !== bAccepted) {
    return aAccepted > bAccepted ? mergeMessageForRead(a, b) : mergeMessageForRead(b, a);
  }

  const cmp = compareNewestFirst(a, b);
  return cmp <= 0 ? mergeMessageForRead(a, b) : mergeMessageForRead(b, a);
}

// Phase 4.E: store ingress/egress uses domain records directly via the
// shared coerceRow helper. nowMs is seeded into the input so tests with
// mocked clocks stay deterministic; explicit fields on input always win.

function coerceMessageRow(input, nowMs) {
  return coerceRow(ChatMessage, input, { seed: { createdAtMs: nowMs }, label: "ChatThreadStore" });
}

function coerceThreadRow(input, nowMs) {
  return coerceRow(ChatThread, input, { seed: { createdAtMs: nowMs }, label: "ChatThreadStore" });
}

function canTransitionStatus(from, to) {
  if (from === to) return true;
  if (from === "pending" && (to === "queued" || to === "sent" || to === "failed" || to === "delivered")) return true;
  if (from === "queued" && (to === "sent" || to === "failed" || to === "delivered")) return true;
  if (from === "sent" && (to === "delivered" || to === "failed")) return true;
  return false;
}

function idempotencyKeyHash(threadId, senderKey, messageId) {
  return Hash.sha256Hex(
    String(threadId || "") + "\u0000" +
    String(senderKey || "") + "\u0000" +
    String(messageId || ""),
  );
}

export class ThreadStoreService {
  constructor({ storageProvider, ownerAccountId, clock = () => Date.now() } = {}) {
    if (!storageProvider || typeof storageProvider.getKeyValueStore !== "function") {
      throw new Error("ThreadStoreService requires storageProvider.getKeyValueStore()");
    }
    if (typeof ownerAccountId !== "string" || !ownerAccountId.trim()) {
      throw new Error("ThreadStoreService requires ownerAccountId");
    }
    if (typeof clock !== "function") {
      throw new Error("ThreadStoreService requires clock function");
    }

    this._ownerAccountId = ownerAccountId.trim();
    this.kv = storageProvider.getKeyValueStore(this._ownerAccountId);
    this.clock = clock;
    this._threadWriteChains = new Map();
  }

  _ownerPrefix(base) {
    return `${base}${this._ownerAccountId}/`;
  }

  _kThread(threadId) {
    return `${this._ownerPrefix(THREAD_PREFIX)}${threadId}`;
  }

  _kMessages(threadId) {
    return `${this._ownerPrefix(MESSAGE_PREFIX)}${threadId}`;
  }

  _kIdempotency(threadId, senderKey, messageId) {
    return `${this._ownerPrefix(IDEMPOTENCY_PREFIX)}${idempotencyKeyHash(threadId, senderKey, messageId)}`;
  }

  _kPendingMutations(targetMessageId) {
    return `${this._ownerPrefix(PENDING_MUTATIONS_PREFIX)}${targetMessageId}`;
  }

  _kOriginalFact(threadId, fingerprint) {
    return `${this._ownerPrefix(ORIGINALS_PREFIX)}${threadId}/${fingerprint}`;
  }

  _kOriginalsIndex(threadId) {
    return `${this._ownerPrefix(ORIGINALS_INDEX_PREFIX)}${threadId}`;
  }

  _kCommitPending(messageId) {
    return `${this._ownerPrefix(COMMIT_PENDING_PREFIX)}${messageId}`;
  }

  _withThreadLock(threadId, operation) {
    const id = nonEmpty(threadId);
    if (!id) return operation();

    const lockId = `${this._ownerAccountId}|${id}`;
    const previous = this._threadWriteChains.get(lockId) || Promise.resolve();
    const run = previous.catch((err) => { console.error("[ChatThreadStore] prior write-chain step failed", err); }).then(() => operation());
    const next = run.finally(() => {
      if (this._threadWriteChains.get(lockId) === next) {
        this._threadWriteChains.delete(lockId);
      }
    });
    this._threadWriteChains.set(lockId, next);
    return next;
  }

  async _loadMessages(threadId) {
    const now = asInt(this.clock(), Date.now());
    const current = await this.kv.get(this._kMessages(threadId));
    if (!Array.isArray(current)) return [];
    return current.map((row) => coerceMessageRow(row, now)).filter(Boolean);
  }

  _assertThreadReadyForMessaging(thread, { threadId, groupId = null } = {}) {
    if (!thread) {
      const err = new Error("Thread is not ready for messaging");
      err.code = "THREAD_NOT_READY";
      throw err;
    }
    const threadType = coerceThreadType(thread.threadType || (thread.groupId ? "group" : "direct"));
    if (threadType === "direct" && nonEmpty(groupId)) {
      throw new Error("Thread type mismatch: existing=direct, attempted group message");
    }
    if (!isReadyForMessaging(thread)) {
      const err = new Error("Thread is not ready for messaging");
      err.code = "THREAD_NOT_READY";
      err.detail = { threadId: nonEmpty(threadId) || thread.threadId || null };
      throw err;
    }
    return thread;
  }

  async _ensureThreadUnlocked({
    threadId,
    createdAtMs,
    threadType = null,
    title = null,
    participants = null,
    groupId = null,
    visibilityState = null,
    accessState = null,
    peerInboxId = null,
    peerAccountId = null,
    lastActivityAtMs = null,
  } = {}) {
    const id = nonEmpty(threadId);
    if (!id) throw new Error("ThreadStoreService.ensureThread requires threadId");

    const now = asInt(this.clock(), Date.now());
    const existing = await this.getThread(id);
    if (existing && existing.threadType === "direct" && nonEmpty(groupId)) {
      throw new Error("Thread type mismatch: existing=direct, attempted group message");
    }
    const nextCreatedAt = (existing && existing.createdAtMs != null) ? existing.createdAtMs : asInt(createdAtMs, now);
    const nextUpdatedAt = now;
    const nextLastActivity = Math.max(
      (existing && existing.lastActivityAtMs != null) ? existing.lastActivityAtMs : 0,
      asInt(lastActivityAtMs, asInt(createdAtMs, now)),
    );
    const providedType = coerceThreadType(threadType);
    const finalThreadType = (existing && existing.threadType) || providedType;

    const next = coerceThreadRow({
      threadId: id,
      threadType: finalThreadType,
      title: nonEmpty(title) || (existing && existing.title) || null,
      createdAtMs: nextCreatedAt,
      updatedAtMs: nextUpdatedAt,
      lastActivityAtMs: nextLastActivity,
      participants: participants || (existing && existing.participants) || [],
      groupId: nonEmpty(groupId) || (existing && existing.groupId) || null,
      visibilityState: visibilityState || (existing && existing.visibilityState),
      accessState: accessState || (existing && existing.accessState),
      peerInboxId: nonEmpty(peerInboxId) || (existing && existing.peerInboxId) || null,
      peerAccountId: nonEmpty(peerAccountId) || (existing && existing.peerAccountId) || null,
    }, now);
    if (!next) throw new Error("ChatThreadStore.ensureThread produced invalid row");

    await this.kv.set(this._kThread(id), next);
    return next;
  }

  async ensureThread({
    threadId,
    createdAtMs,
    threadType = null,
    title = null,
    participants = null,
    groupId = null,
    visibilityState = null,
    accessState = null,
    peerInboxId = null,
    peerAccountId = null,
    lastActivityAtMs = null,
  } = {}) {
    const id = nonEmpty(threadId);
    if (!id) throw new Error("ThreadStoreService.ensureThread requires threadId");
    if (!nonEmpty(threadType)) {
      throw new Error("ThreadStoreService.ensureThread requires threadType ('direct' or 'group')");
    }
    return this._withThreadLock(id, () =>
      this._ensureThreadUnlocked({
        threadId: id,
        createdAtMs,
        threadType,
        title,
        participants,
        groupId,
        visibilityState,
        accessState,
        peerInboxId,
        peerAccountId,
        lastActivityAtMs,
      }),
    );
  }

  async getThread(threadId) {
    const id = nonEmpty(threadId);
    if (!id) return null;
    const now = asInt(this.clock(), Date.now());
    return coerceThreadRow(await this.kv.get(this._kThread(id)), now);
  }

  async setThreadState({ threadId, visibilityState = undefined, accessState = undefined } = {}) {
    const id = nonEmpty(threadId);
    if (!id) throw new Error("ThreadStoreService.setThreadState requires threadId");
    return this._withThreadLock(id, async () => {
      const existing = await this.getThread(id);
      if (!existing) return null;
      const next = await this._ensureThreadUnlocked({
        threadId: id,
        createdAtMs: existing.createdAtMs,
        threadType: existing.threadType,
        title: existing.title,
        participants: existing.participants,
        groupId: existing.groupId,
        visibilityState: visibilityState === undefined ? existing.visibilityState : visibilityState,
        accessState: accessState === undefined ? existing.accessState : accessState,
        peerInboxId: existing.peerInboxId,
        peerAccountId: existing.peerAccountId,
        lastActivityAtMs: existing.lastActivityAtMs,
      });
      return next;
    });
  }

  async deleteThread(threadId) {
    const id = nonEmpty(threadId);
    if (!id) throw new Error("ThreadStoreService.deleteThread requires threadId");
    return this._withThreadLock(id, async () => {
      const existing = await this.getThread(id);
      if (!existing) return false;
      await this.kv.delete(this._kThread(id));
      await this.kv.delete(this._kMessages(id));
      return true;
    });
  }

  async listThreadIds() {
    const keys = await this.kv.keys(this._ownerPrefix(THREAD_PREFIX));
    return keys
      .map((key) => key.slice(this._ownerPrefix(THREAD_PREFIX).length))
      .map((id) => nonEmpty(id))
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
  }

  async getMessageByIdempotency({ threadId, senderKey, messageId } = {}) {
    const id = nonEmpty(threadId);
    const sender = nonEmpty(senderKey);
    const mid = nonEmpty(messageId);
    if (!id || !sender || !mid) return null;

    const now = asInt(this.clock(), Date.now());
    return coerceMessageRow(await this.kv.get(this._kIdempotency(id, sender, mid)), now);
  }

  async listMessages({ threadId, limit = 50, before = null } = {}) {
    const id = nonEmpty(threadId);
    if (!id) {
      return { items: [], nextBefore: null, messages: [], cursor: null };
    }

    const max = Math.max(1, Math.min(MAX_MESSAGES_PER_THREAD, asInt(limit, 50)));
    const list = await this._loadMessages(id);
    list.sort(compareNewestFirst);

    const filtered = list.filter((msg) => isStrictlyBeforeCursor(msg, before));
    const items = filtered.slice(0, max);
    const last = items.length > 0 ? items[items.length - 1] : null;
    const nextBefore = last
      ? { createdAtMs: asInt(last.createdAtMs, 0), messageId: String(last.messageId || "") }
      : null;

    return {
      items,
      nextBefore,
      messages: items,
      cursor: nextBefore,
    };
  }

  async _upsertMessageUnlocked(messageInput) {
    const now = asInt(this.clock(), Date.now());
    const message = coerceMessageRow(messageInput, now);
    if (!message) throw new Error("ThreadStoreService.upsertMessage requires messageId and threadId");
    const thread = await this.getThread(message.threadId);
    this._assertThreadReadyForMessaging(thread, {
      threadId: message.threadId,
      groupId: messageInput && messageInput.groupId,
    });

    const key = this._kMessages(message.threadId);
    const raw = await this._loadMessages(message.threadId);
    const at = raw.findIndex((item) => item.messageId === message.messageId);
    if (at >= 0) raw[at] = message;
    else raw.push(message);
    raw.sort(compareNewestFirst);
    const bounded = raw.slice(0, MAX_MESSAGES_PER_THREAD);
    await this.kv.set(key, bounded);

    await this._ensureThreadUnlocked({
      threadId: message.threadId,
      createdAtMs: message.createdAtMs,
      groupId: nonEmpty(messageInput && messageInput.groupId),
      lastActivityAtMs: message.createdAtMs,
    });

    return message;
  }

  async upsertMessage(messageInput) {
    const message = coerceMessageRow(messageInput, asInt(this.clock(), Date.now()));
    if (!message) throw new Error("ThreadStoreService.upsertMessage requires messageId and threadId");
    return this._withThreadLock(message.threadId, () => this._upsertMessageUnlocked(messageInput));
  }

  async recordOutboundDeposit({
    threadId,
    senderKey,
    messageId,
    senderAccountId = null,
    packetB64,
    acceptedAtMs,
    text = "",
    payload = null,
  } = {}) {
    const id = nonEmpty(threadId);
    const sender = nonEmpty(senderKey);
    const mid = nonEmpty(messageId);
    if (!id || !sender || !mid) {
      throw new Error("ThreadStoreService.recordOutboundDeposit requires threadId/senderKey/messageId");
    }

    return this._withThreadLock(id, async () => {
      const now = asInt(this.clock(), Date.now());
      const createdAt = asInt(acceptedAtMs, now);
      const thread = await this.getThread(id);
      this._assertThreadReadyForMessaging(thread, { threadId: id });

      const canonical = coerceMessageRow({
        messageId: mid,
        threadId: id,
        packetB64,
        text,
        payload,
        senderKey: sender,
        senderAccountId,
        status: "pending",
        sentAtMs: null,
        acceptedAtMs: null,
        createdAtMs: createdAt,
      }, now);

      await this._upsertMessageUnlocked(canonical);
      await this.kv.set(this._kIdempotency(id, sender, mid), canonical);
      return canonical;
    });
  }

  async recordOutboundPending({
    threadId,
    senderKey,
    messageId,
    senderAccountId = null,
    packetB64,
    createdAtMs,
  } = {}) {
    const id = nonEmpty(threadId);
    const sender = nonEmpty(senderKey);
    const mid = nonEmpty(messageId);
    if (!id || !sender || !mid) {
      throw new Error("ThreadStoreService.recordOutboundPending requires threadId/senderKey/messageId");
    }
    return this._withThreadLock(id, async () => {
      const thread = await this.getThread(id);
      this._assertThreadReadyForMessaging(thread, { threadId: id });
      const existing = await this.getMessageByIdempotency({
        threadId: id,
        senderKey: sender,
        messageId: mid,
      });
      if (existing) return existing;

      const now = asInt(this.clock(), Date.now());
      const at = asInt(createdAtMs, now);
      const pending = coerceMessageRow({
        messageId: mid,
        threadId: id,
        packetB64,
        senderKey: sender,
        senderAccountId,
        status: "pending",
        sentAtMs: null,
        acceptedAtMs: null,
        createdAtMs: at,
      }, now);
      await this._upsertMessageUnlocked(pending);
      await this.kv.set(this._kIdempotency(id, sender, mid), pending);
      return pending;
    });
  }

  async setMessageStatus({ threadId, messageId, status, sentAtMs = null, acceptedAtMs = null } = {}) {
    const id = nonEmpty(threadId);
    const mid = nonEmpty(messageId);
    const nextStatus = nonEmpty(status);
    if (!id || !mid || !nextStatus) {
      throw new Error("ThreadStoreService.setMessageStatus requires threadId/messageId/status");
    }
    if (!VALID_MESSAGE_STATUSES.includes(nextStatus)) {
      throw new Error("ThreadStoreService.setMessageStatus invalid status");
    }

    return this._withThreadLock(id, async () => {
      const messages = await this._loadMessages(id);
      const at = messages.findIndex((row) => row.messageId === mid);
      if (at < 0) return null;
      const current = messages[at];
      if (!canTransitionStatus(current.status, nextStatus)) {
        throw new Error(
          `ThreadStoreService.setMessageStatus invalid transition ${current.status} -> ${nextStatus}`,
        );
      }
      const updated = {
        ...current,
        status: nextStatus,
        sentAtMs: sentAtMs == null ? current.sentAtMs : asInt(sentAtMs, asInt(this.clock(), Date.now())),
        acceptedAtMs:
          nextStatus === "delivered"
            ? asInt(
                acceptedAtMs == null ? sentAtMs : acceptedAtMs,
                asInt(this.clock(), Date.now()),
              )
            : current.acceptedAtMs,
      };
      messages[at] = updated;
      messages.sort(compareNewestFirst);
      await this.kv.set(this._kMessages(id), messages.slice(0, MAX_MESSAGES_PER_THREAD));

      if (current.senderKey && current.messageId) {
        await this.kv.set(this._kIdempotency(id, current.senderKey, current.messageId), updated);
      }
      return updated;
    });
  }

  async upsertDepositedMessage({
    messageId,
    threadId,
    senderKey,
    packetB64,
    acceptedAtMs,
    senderAccountId = null,
    status = "delivered",
    text = "",
    payload = null,
    inReplyToMessageId = "",
  } = {}) {
    const id = nonEmpty(threadId);
    const mid = nonEmpty(messageId);
    if (!id || !mid) {
      throw new Error("ThreadStoreService.upsertDepositedMessage requires messageId and threadId");
    }

    return this._withThreadLock(id, async () => {
      const now = asInt(this.clock(), Date.now());
      const createdAt = asInt(acceptedAtMs, now);
      const initialStatus = VALID_MESSAGE_STATUSES.includes(String(status || "").trim())
        ? String(status).trim()
        : "delivered";
      const normalizedSenderKey = nonEmpty(senderKey);
      const thread = await this.getThread(id);
      this._assertThreadReadyForMessaging(thread, { threadId: id });
      const existingMessages = await this._loadMessages(id);
      const incomingSender = nonEmpty(senderAccountId);
      let effectiveMid = mid;
      const existing = existingMessages.find((row) => row.messageId === mid) || null;
      if (existing) {
        const existingSender = nonEmpty(existing.senderAccountId);
        // Genuine idempotent re-delivery: same authenticated sender (or we have no
        // sender identity to distinguish by) → collapse, as before.
        if (!incomingSender || !existingSender || existingSender === incomingSender) {
          // AE-1 (frozen conflict semantic, plan §5): when BOTH rows are SIGNED
          // facts from the same sender and their fingerprints differ, this is
          // an integrity conflict — never a silent collapse. Both facts are
          // retained in the originals log (the caller appends before this
          // upsert); the projection row is flagged `conflicted`, and NO winner
          // is chosen — the first-stored row stays displayed only as the
          // carrier of the flag, not as the canonical content. Unsigned rows
          // (either side) keep the pre-AE-1 collapse: no fingerprint exists to
          // distinguish by.
          const incomingHash = payload && typeof payload === "object" ? nonEmpty(payload.contentHash) : "";
          const existingHash = existing.payload && typeof existing.payload === "object"
            ? nonEmpty(existing.payload.contentHash)
            : "";
          if (incomingHash && existingHash && incomingHash !== existingHash
              && incomingSender && existingSender === incomingSender) {
            const flagged = coerceMessageRow({ ...existing, conflicted: true }, now);
            const at = existingMessages.findIndex((row) => row.messageId === existing.messageId);
            existingMessages[at] = flagged;
            await this.kv.set(this._kMessages(id), existingMessages.slice(0, MAX_MESSAGES_PER_THREAD));
            if (existing.senderKey && existing.messageId) {
              await this.kv.set(this._kIdempotency(id, existing.senderKey, existing.messageId), flagged);
            }
            return { inserted: false, message: flagged, mutated: false, conflict: true };
          }
          return { inserted: false, message: existing, mutated: false };
        }
        // TRUST-1: messageId is attacker-choosable, so one account must NEVER be
        // able to collide/pre-seed an id to SUPPRESS another account's message
        // (first-write-wins would silently drop the legitimate one). The
        // authenticated sender is the source of truth: bind the stored id to it so
        // BOTH messages survive. The original id keeps resolving the first row;
        // edit/tombstone author-checks already gate on senderAccountId, so the
        // disambiguated row can only ever be mutated by its real owner.
        effectiveMid = mid + "@" + incomingSender;
        const dupe = existingMessages.find((row) => row.messageId === effectiveMid) || null;
        if (dupe) return { inserted: false, message: dupe, mutated: false };
      }
      const stored = await this._upsertMessageUnlocked({
        messageId: effectiveMid,
        threadId: id,
        packetB64,
        text,
        payload,
        senderKey: normalizedSenderKey,
        senderAccountId: incomingSender,
        status: initialStatus,
        sentAtMs: initialStatus === "pending" ? null : createdAt,
        acceptedAtMs: initialStatus === "delivered" ? createdAt : null,
        createdAtMs: createdAt,
        inReplyToMessageId,
      });
      if (normalizedSenderKey) {
        await this.kv.set(this._kIdempotency(id, normalizedSenderKey, mid), stored);
      }
      const drained = await this._drainPendingMutationsUnlocked({
        threadId: id,
        targetMessageId: effectiveMid,
      });
      // `mutated` tells the caller the freshly-deposited row already had
      // out-of-order edits/reactions/tombstones folded in, so it knows to emit
      // message.updated on top of message.deposited — otherwise those mutations
      // are persisted but never reach the renderer until a refetch.
      return { inserted: true, message: drained || stored, mutated: Boolean(drained) };
    });
  }

  /**
   * AE-1: append one OriginalMessage fact to the immutable per-thread log.
   * Fingerprint-keyed and idempotent — re-appending an existing fingerprint
   * is a no-op. For base messages the (senderAccountId, messageId) index is
   * maintained; a second DIFFERENT fingerprint under one identity is the
   * frozen integrity conflict — both facts stay, `conflict` reports it, and
   * no winner is ever chosen.
   * @param {{threadId:string, fact:{fingerprint:string, payload:object, receivedAtMs?:number, origin?:string}}} args
   * @returns {Promise<{appended:boolean, conflict:{senderAccountId,messageId,fingerprints:string[]}|null, fact:object}>}
   */
  async appendOriginalFact({ threadId, fact } = {}) {
    const id = nonEmpty(threadId);
    const f = fact && typeof fact === "object" ? fact : null;
    const fingerprint = f ? nonEmpty(f.fingerprint) : "";
    const payload = f && f.payload && typeof f.payload === "object" ? f.payload : null;
    if (!id || !fingerprint || !payload) {
      throw new Error("ThreadStoreService.appendOriginalFact requires threadId, fact.fingerprint, fact.payload");
    }
    const kind = nonEmpty(payload.kind);
    const senderAccountId = nonEmpty(payload.senderAccountId);
    if (!kind || !senderAccountId) {
      throw new Error("ThreadStoreService.appendOriginalFact requires payload.kind and payload.senderAccountId");
    }
    return this._withThreadLock(id, async () => {
      const key = this._kOriginalFact(id, fingerprint);
      const existing = await this.kv.get(key);
      if (existing && typeof existing === "object") {
        return { appended: false, conflict: null, fact: existing };
      }
      const now = asInt(this.clock(), Date.now());
      const row = {
        fingerprint,
        kind,
        threadId: id,
        senderAccountId,
        messageId: nonEmpty(payload.messageId) || null,
        targetMessageId: nonEmpty(payload.targetMessageId) || null,
        targetFingerprint: nonEmpty(payload.targetFingerprint) || null,
        receivedAtMs: asInt(f.receivedAtMs, now),
        origin: nonEmpty(f.origin) || "live",
        payload,
      };
      await this.kv.set(key, row);
      let conflict = null;
      if (kind === MESSAGE_KIND && row.messageId) {
        const indexKey = this._kOriginalsIndex(id);
        const rawIndex = await this.kv.get(indexKey);
        const index = rawIndex && typeof rawIndex === "object"
          && rawIndex.byMessage && typeof rawIndex.byMessage === "object"
          ? rawIndex
          : { byMessage: {} };
        // The \u0000 separator makes the composite key structurally distinct
        // from any bare payload-controlled string (no __proto__ collisions).
        const identityKey = senderAccountId + "\u0000" + row.messageId;
        const entryRaw = index.byMessage[identityKey];
        const entry = entryRaw && typeof entryRaw === "object" && Array.isArray(entryRaw.fingerprints)
          ? { fingerprints: entryRaw.fingerprints.slice(), conflicted: entryRaw.conflicted === true }
          : { fingerprints: [], conflicted: false };
        if (!entry.fingerprints.includes(fingerprint)) entry.fingerprints.push(fingerprint);
        if (entry.fingerprints.length > 1) {
          entry.conflicted = true;
          conflict = { senderAccountId, messageId: row.messageId, fingerprints: entry.fingerprints.slice() };
        }
        index.byMessage[identityKey] = entry;
        await this.kv.set(indexKey, index);
      }
      return { appended: true, conflict, fact: row };
    });
  }

  /** AE-1: load one fact by fingerprint (null when absent). */
  async getOriginalFact({ threadId, fingerprint } = {}) {
    const id = nonEmpty(threadId);
    const fp = nonEmpty(fingerprint);
    if (!id || !fp) return null;
    const row = await this.kv.get(this._kOriginalFact(id, fp));
    return row && typeof row === "object" ? row : null;
  }

  /**
   * AE-1: every fact fingerprint in a thread, sorted — the digest/inventory
   * seam AE-2's convergence loop reads.
   */
  async listOriginalFingerprints({ threadId } = {}) {
    const id = nonEmpty(threadId);
    if (!id) return [];
    const prefix = this._kOriginalFact(id, "");
    const keys = await this.kv.keys(prefix);
    return keys
      .map((key) => key.slice(prefix.length))
      .filter((fp) => fp.length > 0)
      .sort();
  }

  /**
   * AE-1: base-kind facts recorded under a messageId (optionally narrowed to
   * one sender) — the sender-side `targetFingerprint` resolution for
   * mutations, and the conflict-inspection read. More than one fact for a
   * single (sender, messageId) identity = the frozen integrity conflict.
   */
  async findBaseFactsByMessageId({ threadId, messageId, senderAccountId = null } = {}) {
    const id = nonEmpty(threadId);
    const mid = nonEmpty(messageId);
    if (!id || !mid) return [];
    const rawIndex = await this.kv.get(this._kOriginalsIndex(id));
    const byMessage = rawIndex && typeof rawIndex === "object"
      && rawIndex.byMessage && typeof rawIndex.byMessage === "object"
      ? rawIndex.byMessage
      : {};
    const wantedSender = nonEmpty(senderAccountId);
    const fingerprints = [];
    for (const identityKey of Object.keys(byMessage)) {
      const sep = identityKey.indexOf("\u0000");
      if (sep < 0) continue;
      const sender = identityKey.slice(0, sep);
      const keyMid = identityKey.slice(sep + 1);
      if (keyMid !== mid) continue;
      if (wantedSender && sender !== wantedSender) continue;
      const entry = byMessage[identityKey];
      if (entry && Array.isArray(entry.fingerprints)) {
        for (const fp of entry.fingerprints) {
          if (typeof fp === "string" && fp.length > 0 && !fingerprints.includes(fp)) fingerprints.push(fp);
        }
      }
    }
    const facts = [];
    for (const fp of fingerprints) {
      const row = await this.kv.get(this._kOriginalFact(id, fp));
      if (row && typeof row === "object") facts.push(row);
    }
    return facts;
  }

  /**
   * MessageCommitAck: create/replace the durable pending-commit row for one
   * signed outbound message. Keyed by messageId (one outstanding claim per
   * outbound message); the fingerprint is the claim the eventual ack must
   * match. Throws on missing identity fields — a pending row that cannot
   * name what it is waiting for is unrepairable.
   */
  async putPendingCommit({
    messageId,
    threadId,
    fingerprint,
    recipientAccountId,
    firstSentAtMs,
    attempts = 0,
    nextRetryAtMs,
    lastAttemptAtMs = null,
  } = {}) {
    const mid = nonEmpty(messageId);
    const id = nonEmpty(threadId);
    const fp = nonEmpty(fingerprint);
    const recipient = nonEmpty(recipientAccountId);
    if (!mid || !id || !fp || !recipient) {
      throw new Error("ThreadStoreService.putPendingCommit requires messageId, threadId, fingerprint, recipientAccountId");
    }
    const now = asInt(this.clock(), Date.now());
    const row = {
      messageId: mid,
      threadId: id,
      fingerprint: fp,
      recipientAccountId: recipient,
      firstSentAtMs: asInt(firstSentAtMs, now),
      attempts: Number.isInteger(attempts) && attempts >= 0 ? attempts : 0,
      nextRetryAtMs: asInt(nextRetryAtMs, now),
      lastAttemptAtMs: Number.isInteger(lastAttemptAtMs) ? lastAttemptAtMs : null,
    };
    await this.kv.set(this._kCommitPending(mid), row);
    return row;
  }

  /** MessageCommitAck: the pending-commit row for a messageId (null when none). */
  async getPendingCommit({ messageId } = {}) {
    const mid = nonEmpty(messageId);
    if (!mid) return null;
    const row = await this.kv.get(this._kCommitPending(mid));
    return row && typeof row === "object" ? row : null;
  }

  /** MessageCommitAck: terminal consume (verified proof) or explicit drop. */
  async deletePendingCommit({ messageId } = {}) {
    const mid = nonEmpty(messageId);
    if (!mid) return false;
    await this.kv.delete(this._kCommitPending(mid));
    return true;
  }

  /** MessageCommitAck: every outstanding pending-commit row (the sweep's input). */
  async listPendingCommits() {
    const prefix = this._ownerPrefix(COMMIT_PENDING_PREFIX);
    const keys = await this.kv.keys(prefix);
    const rows = [];
    for (const key of keys) {
      const row = await this.kv.get(key);
      if (row && typeof row === "object" && nonEmpty(row.messageId)) rows.push(row);
    }
    return rows;
  }

  /**
   * AE-1: flag the projection row for a message whose identity is in
   * integrity conflict. The originals log holds the truth (both facts);
   * this only surfaces it. Returns the updated row, or null when no
   * projection row exists (e.g. rotated out by the per-thread cap).
   */
  async markMessageConflicted({ threadId, messageId } = {}) {
    const id = nonEmpty(threadId);
    const mid = nonEmpty(messageId);
    if (!id || !mid) return null;
    return this._withThreadLock(id, async () => {
      const messages = await this._loadMessages(id);
      const at = messages.findIndex((row) => row.messageId === mid);
      if (at < 0) return null;
      const current = messages[at];
      if (current.conflicted === true) return current;
      const now = asInt(this.clock(), Date.now());
      const updated = coerceMessageRow({ ...current, conflicted: true }, now);
      messages[at] = updated;
      await this.kv.set(this._kMessages(id), messages.slice(0, MAX_MESSAGES_PER_THREAD));
      if (current.senderKey && current.messageId) {
        await this.kv.set(this._kIdempotency(id, current.senderKey, current.messageId), updated);
      }
      return updated;
    });
  }

  async _loadPendingMutations(targetMessageId) {
    const key = this._kPendingMutations(targetMessageId);
    const raw = await this.kv.get(key);
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const row of raw) {
      const record = coerceRow(PendingMutation, row, { label: "PendingMutation" });
      if (record) out.push(record);
    }
    return out;
  }

  async _writePendingMutations(targetMessageId, list) {
    const key = this._kPendingMutations(targetMessageId);
    if (!Array.isArray(list) || list.length === 0) {
      await this.kv.delete(key);
      return;
    }
    const trimmed = list
      .slice(-MAX_PENDING_MUTATIONS_PER_TARGET)
      .map((record) => record.toJSON());
    await this.kv.set(key, trimmed);
  }

  async _bufferMutationUnlocked(mutation) {
    if (!(mutation instanceof PendingMutation)) {
      throw new Error("_bufferMutationUnlocked requires a PendingMutation record instance");
    }
    const current = await this._loadPendingMutations(mutation.targetMessageId);
    current.push(mutation);
    current.sort((a, b) => a.receivedAtMs - b.receivedAtMs);
    await this._writePendingMutations(mutation.targetMessageId, current);
  }

  async _drainPendingMutationsUnlocked({ threadId, targetMessageId } = {}) {
    const id = nonEmpty(threadId);
    const target = nonEmpty(targetMessageId);
    if (!id || !target) return null;
    const pending = await this._loadPendingMutations(target);
    if (pending.length === 0) return null;
    pending.sort((a, b) => a.receivedAtMs - b.receivedAtMs);
    let latest = null;
    for (const mutation of pending) {
      let result = null;
      if (mutation.kind === PENDING_MUTATION_KINDS.EDIT) {
        result = await this._applyEditCoreUnlocked({
          threadId: id,
          targetMessageId: target,
          senderAccountId: mutation.senderAccountId,
          newText: mutation.newText,
          editedAtMs: mutation.editedAtMs,
        });
      } else if (mutation.kind === PENDING_MUTATION_KINDS.TOMBSTONE) {
        result = await this._applyTombstoneCoreUnlocked({
          threadId: id,
          targetMessageId: target,
          senderAccountId: mutation.senderAccountId,
          tombstonedAtMs: mutation.tombstonedAtMs,
        });
      } else if (mutation.kind === PENDING_MUTATION_KINDS.REACTION_ADD
        || mutation.kind === PENDING_MUTATION_KINDS.REACTION_REMOVE) {
        result = await this._applyReactionCoreUnlocked({
          threadId: id,
          targetMessageId: target,
          senderAccountId: mutation.senderAccountId,
          emoji: mutation.emoji,
          op: mutation.kind === PENDING_MUTATION_KINDS.REACTION_ADD ? "add" : "remove",
        });
      }
      if (result && result.message) latest = result.message;
    }
    await this._writePendingMutations(target, []);
    return latest;
  }

  async cleanupStalePendingMutations() {
    const now = asInt(this.clock(), Date.now());
    const prefix = this._ownerPrefix(PENDING_MUTATIONS_PREFIX);
    const keys = await this.kv.keys(prefix);
    for (const key of keys) {
      const raw = await this.kv.get(key);
      if (!Array.isArray(raw)) {
        await this.kv.delete(key);
        continue;
      }
      const rehydrated = [];
      for (const row of raw) {
        const record = coerceRow(PendingMutation, row, { label: "PendingMutation" });
        if (!record) continue;
        const age = now - record.receivedAtMs;
        if (age < 0 || age > PENDING_MUTATION_TTL_MS) continue;
        rehydrated.push(record);
      }
      if (rehydrated.length === 0) {
        await this.kv.delete(key);
      } else if (rehydrated.length !== raw.length) {
        await this.kv.set(key, rehydrated.map((record) => record.toJSON()));
      }
    }
  }

  async _applyEditCoreUnlocked({ threadId, targetMessageId, senderAccountId, newText, editedAtMs } = {}) {
    const id = nonEmpty(threadId);
    const target = nonEmpty(targetMessageId);
    if (!id || !target) return { applied: false, rejected: true, reason: "invalid_input", message: null };
    const messages = await this._loadMessages(id);
    const at = messages.findIndex((row) => row.messageId === target);
    if (at < 0) return { applied: false, rejected: false, reason: "target_not_found", message: null };
    const current = messages[at];
    if (current.tombstonedAtMs) {
      return { applied: false, rejected: true, reason: "tombstoned", message: current };
    }
    const expectedSender = nonEmpty(current.senderAccountId);
    if (expectedSender && expectedSender !== nonEmpty(senderAccountId)) {
      return { applied: false, rejected: true, reason: "unauthorized", message: current };
    }
    const incomingEditedAt = asInt(editedAtMs, 0);
    if (incomingEditedAt <= 0) {
      return { applied: false, rejected: true, reason: "invalid_editedAtMs", message: current };
    }
    const currentEditedAt = asInt(current.editedAtMs, 0);
    if (currentEditedAt && currentEditedAt >= incomingEditedAt) {
      return { applied: false, rejected: false, reason: "stale", message: current };
    }
    const now = asInt(this.clock(), Date.now());
    const updated = coerceMessageRow({
      ...current,
      text: typeof newText === "string" ? newText : "",
      payload: current.payload && typeof current.payload === "object"
        ? { ...current.payload, text: typeof newText === "string" ? newText : "" }
        : current.payload,
      editedAtMs: incomingEditedAt,
    }, now);
    messages[at] = updated;
    messages.sort(compareNewestFirst);
    await this.kv.set(this._kMessages(id), messages.slice(0, MAX_MESSAGES_PER_THREAD));
    if (current.senderKey && current.messageId) {
      await this.kv.set(this._kIdempotency(id, current.senderKey, current.messageId), updated);
    }
    return { applied: true, rejected: false, message: updated };
  }

  async _applyTombstoneCoreUnlocked({ threadId, targetMessageId, senderAccountId, tombstonedAtMs } = {}) {
    const id = nonEmpty(threadId);
    const target = nonEmpty(targetMessageId);
    if (!id || !target) return { applied: false, rejected: true, reason: "invalid_input", message: null };
    const messages = await this._loadMessages(id);
    const at = messages.findIndex((row) => row.messageId === target);
    if (at < 0) return { applied: false, rejected: false, reason: "target_not_found", message: null };
    const current = messages[at];
    const expectedSender = nonEmpty(current.senderAccountId);
    if (expectedSender && expectedSender !== nonEmpty(senderAccountId)) {
      return { applied: false, rejected: true, reason: "unauthorized", message: current };
    }
    if (current.tombstonedAtMs) {
      return { applied: false, rejected: false, reason: "already_tombstoned", message: current };
    }
    const incomingAt = asInt(tombstonedAtMs, 0);
    if (incomingAt <= 0) {
      return { applied: false, rejected: true, reason: "invalid_tombstonedAtMs", message: current };
    }
    const now = asInt(this.clock(), Date.now());
    const updated = coerceMessageRow({
      ...current,
      text: "",
      payload: null,
      tombstonedAtMs: incomingAt,
    }, now);
    messages[at] = updated;
    messages.sort(compareNewestFirst);
    await this.kv.set(this._kMessages(id), messages.slice(0, MAX_MESSAGES_PER_THREAD));
    if (current.senderKey && current.messageId) {
      await this.kv.set(this._kIdempotency(id, current.senderKey, current.messageId), updated);
    }
    return { applied: true, rejected: false, message: updated };
  }

  async _applyReactionCoreUnlocked({ threadId, targetMessageId, senderAccountId, emoji, op } = {}) {
    const id = nonEmpty(threadId);
    const target = nonEmpty(targetMessageId);
    const sender = nonEmpty(senderAccountId);
    const e = nonEmpty(emoji);
    if (!id || !target || !sender || !e || (op !== "add" && op !== "remove")) {
      return { applied: false, rejected: true, reason: "invalid_input", message: null };
    }
    const messages = await this._loadMessages(id);
    const at = messages.findIndex((row) => row.messageId === target);
    if (at < 0) return { applied: false, rejected: false, reason: "target_not_found", message: null };
    const current = messages[at];
    const nextReactions = coerceReactions(current.reactions);
    const currentSet = new Set(nextReactions[e] || []);
    const had = currentSet.has(sender);
    if (op === "add" && !had) currentSet.add(sender);
    if (op === "remove" && had) currentSet.delete(sender);
    const isUnchanged = (op === "add" && had) || (op === "remove" && !had);
    if (isUnchanged) {
      return { applied: false, rejected: false, reason: "no_change", message: current };
    }
    if (currentSet.size === 0) {
      delete nextReactions[e];
    } else {
      nextReactions[e] = Array.from(currentSet);
    }
    const now = asInt(this.clock(), Date.now());
    const updated = coerceMessageRow({
      ...current,
      reactions: nextReactions,
    }, now);
    messages[at] = updated;
    messages.sort(compareNewestFirst);
    await this.kv.set(this._kMessages(id), messages.slice(0, MAX_MESSAGES_PER_THREAD));
    if (current.senderKey && current.messageId) {
      await this.kv.set(this._kIdempotency(id, current.senderKey, current.messageId), updated);
    }
    return { applied: true, rejected: false, message: updated };
  }

  async applyEdit({ threadId, targetMessageId, senderAccountId, newText, editedAtMs, receivedAtMs, allowBuffer = true } = {}) {
    const id = nonEmpty(threadId);
    const target = nonEmpty(targetMessageId);
    if (!id || !target) {
      throw new Error("ThreadStoreService.applyEdit requires threadId and targetMessageId");
    }
    return this._withThreadLock(id, async () => {
      const result = await this._applyEditCoreUnlocked({
        threadId: id,
        targetMessageId: target,
        senderAccountId,
        newText,
        editedAtMs,
      });
      if (!result.applied && result.reason === "target_not_found" && allowBuffer) {
        await this._bufferMutationUnlocked(new PendingMutation({
          kind: PENDING_MUTATION_KINDS.EDIT,
          threadId: id,
          targetMessageId: target,
          senderAccountId: nonEmpty(senderAccountId),
          newText: typeof newText === "string" ? newText : "",
          editedAtMs: asInt(editedAtMs, 0),
          receivedAtMs: asInt(receivedAtMs, asInt(this.clock(), Date.now())),
        }));
        return { ...result, buffered: true };
      }
      return { ...result, buffered: false };
    });
  }

  async applyTombstone({ threadId, targetMessageId, senderAccountId, tombstonedAtMs, receivedAtMs, allowBuffer = true } = {}) {
    const id = nonEmpty(threadId);
    const target = nonEmpty(targetMessageId);
    if (!id || !target) {
      throw new Error("ThreadStoreService.applyTombstone requires threadId and targetMessageId");
    }
    return this._withThreadLock(id, async () => {
      const result = await this._applyTombstoneCoreUnlocked({
        threadId: id,
        targetMessageId: target,
        senderAccountId,
        tombstonedAtMs,
      });
      if (!result.applied && result.reason === "target_not_found" && allowBuffer) {
        await this._bufferMutationUnlocked(new PendingMutation({
          kind: PENDING_MUTATION_KINDS.TOMBSTONE,
          threadId: id,
          targetMessageId: target,
          senderAccountId: nonEmpty(senderAccountId),
          tombstonedAtMs: asInt(tombstonedAtMs, 0),
          receivedAtMs: asInt(receivedAtMs, asInt(this.clock(), Date.now())),
        }));
        return { ...result, buffered: true };
      }
      return { ...result, buffered: false };
    });
  }

  async applyReaction({ threadId, targetMessageId, senderAccountId, emoji, op, receivedAtMs, allowBuffer = true } = {}) {
    const id = nonEmpty(threadId);
    const target = nonEmpty(targetMessageId);
    if (!id || !target) {
      throw new Error("ThreadStoreService.applyReaction requires threadId and targetMessageId");
    }
    return this._withThreadLock(id, async () => {
      const result = await this._applyReactionCoreUnlocked({
        threadId: id,
        targetMessageId: target,
        senderAccountId,
        emoji,
        op,
      });
      if (!result.applied && result.reason === "target_not_found" && allowBuffer) {
        await this._bufferMutationUnlocked(new PendingMutation({
          kind: op === "add" ? PENDING_MUTATION_KINDS.REACTION_ADD : PENDING_MUTATION_KINDS.REACTION_REMOVE,
          threadId: id,
          targetMessageId: target,
          senderAccountId: nonEmpty(senderAccountId),
          emoji: nonEmpty(emoji),
          receivedAtMs: asInt(receivedAtMs, asInt(this.clock(), Date.now())),
        }));
        return { ...result, buffered: true };
      }
      return { ...result, buffered: false };
    });
  }

  async applyLocalDelete({ threadId, targetMessageId } = {}) {
    const id = nonEmpty(threadId);
    const target = nonEmpty(targetMessageId);
    if (!id || !target) {
      throw new Error("ThreadStoreService.applyLocalDelete requires threadId and targetMessageId");
    }
    return this._withThreadLock(id, async () => {
      const messages = await this._loadMessages(id);
      const at = messages.findIndex((row) => row.messageId === target);
      if (at < 0) return { removed: false };
      const removed = messages[at];
      messages.splice(at, 1);
      await this.kv.set(this._kMessages(id), messages.slice(0, MAX_MESSAGES_PER_THREAD));
      if (removed && removed.senderKey && removed.messageId) {
        await this.kv.delete(this._kIdempotency(id, removed.senderKey, removed.messageId));
      }
      return { removed: true };
    });
  }
}
