import { randomUUID } from "node:crypto";
import { REZ_CONTRACT_TYPES } from "@rezprotocol/sdk/client";
import {
  MessageSendParams,
  MessageSendResult,
  MessageStatusEvent,
  MessageUpdatedEvent,
  MessageRemovedEvent,
  MessageDepositedEvent,
  MessageEditParams,
  MessageEditResult,
  MessageTombstoneParams,
  MessageTombstoneResult,
  MessageDeleteLocalParams,
  MessageDeleteLocalResult,
  MessageReactionAddParams,
  MessageReactionAddResult,
  MessageReactionRemoveParams,
  MessageReactionRemoveResult,
  ThreadMessagesListParams,
  ThreadMessagesListResult,
  ChatMessage,
} from "../../records/index.js";
import {
  ChatMessagePayloadV1,
  ChatMessageEditPayloadV1,
  ChatMessageTombstonePayloadV1,
  ChatReactionPayloadV1,
  MESSAGE_EDIT_KIND,
  MESSAGE_TOMBSTONE_KIND,
  REACTION_KIND,
} from "../../records/payloads/index.js";
import { BaseServerService } from "../base/BaseServerService.js";

export class ServerMessagesService extends BaseServerService {
  static QUEUE_TTL_MS = 72 * 60 * 60 * 1000;

  #threadStore;
  #threadIndex;
  #groupStore;
  #clock;
  #queuedMessages;
  // messageId → threadId for outbound messages awaiting a delivery ack.
  // E2eeDeliveryAckV1 carries only messageIds (no threadId — that's a
  // chat-layer concept), so we need this side table to resolve the
  // ack's target thread when it arrives. Populated on outbound send,
  // cleared on ack consume. In-memory only: if the sender restarts
  // before the ack arrives, the row stays at "sent" forever, which is
  // an acceptable degradation (ack delivery is best-effort already).
  #ackPending = new Map();
  // Outbound queue tracking. The node owns the authoritative 72h queue
  // and signals state transitions via EVT_OUTBOUND_STATUS frames. We
  // correlate those frames back to chat-layer messageIds via the
  // resolved deliverInboxId captured at send time.
  //   #queuedByInbox: deliverInboxId → Set<messageId>
  //   #queueTracking: messageId → { threadId, outstandingInboxIds, anyDelivered }
  #queuedByInbox = new Map();
  #queueTracking = new Map();
  #outboundStatusUnsubscribe = null;
  // Per-(messageId, peerDeviceId) sealed-ciphertext cache for gated per-device
  // fan-out (Audit R2 #4). Re-encrypting a device on a send retry advances that
  // device's ratchet AGAIN — duplicating to already-delivered devices and burning
  // the failed device's skip tolerance. So we encrypt ONCE per device per message
  // and, on a retry of the SAME messageId, replay the identical bytes ONLY to
  // devices not yet delivered (re-dispatching to a delivered device would
  // double-advance its receive ratchet → decrypt-fail). Bounded by TTL + size;
  // entries are transient in-flight state, not durable.
  //   key `${messageId}::${peerDeviceId}` → { sealed, deliveredOk, createdAtMs }
  #deviceFanoutCache = new Map();
  static #DEVICE_FANOUT_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
  static #DEVICE_FANOUT_CACHE_MAX = 4096;

  constructor({
    bus,
    threadStore,
    threadIndex,
    groupStore,
    ownerAccountId,
    clock = () => Date.now(),
    logger = console,
  } = {}) {
    super({ bus, ownerAccountId, logger });
    if (!threadStore || !threadIndex || !groupStore) {
      throw new Error("ServerMessagesService requires thread/index/group stores");
    }
    this.#threadStore = threadStore;
    this.#threadIndex = threadIndex;
    this.#groupStore = groupStore;
    this.#clock = clock;
    this.#queuedMessages = [];
    this._register("thread.messages", "list", (payload) => this.listMessages(payload));
    this._register("message", "send", (payload) => this.sendMessage(payload));
    this._register("message", "edit", (payload) => this.editMessage(payload));
    this._register("message", "tombstone", (payload) => this.tombstoneMessage(payload));
    this._register("message", "deleteLocal", (payload) => this.deleteLocalMessage(payload));
    this._register("message.reaction", "add", (payload) => this.addReaction(payload));
    this._register("message.reaction", "remove", (payload) => this.removeReaction(payload));
  }

  async start() {
    await this.#recoverQueuedMessages().catch((err) => {
      this.logger.error("[ServerMessagesService] queued message recovery failed", err && err.message ? err.message : err);
    });
    const sdk = this.bus.runtime ? this.bus.runtime.sdk : null;
    if (sdk && sdk.subscriptions && typeof sdk.subscriptions.onEvent === "function") {
      this.#outboundStatusUnsubscribe = sdk.subscriptions.onEvent(
        REZ_CONTRACT_TYPES.EVT_OUTBOUND_STATUS,
        (frame) => {
          const body = frame && typeof frame.body === "object" ? frame.body : {};
          this.#handleOutboundStatus(body).catch((err) => {
            this.logger.error("[ServerMessagesService] outbound status handler failed", err && err.message ? err.message : err);
            this._emit("app.error", { source: "ServerMessagesService", message: "outbound status handler failed", severity: "error", err });
          });
        },
      );
    }
  }

  async stop() {
    if (typeof this.#outboundStatusUnsubscribe === "function") {
      this.#outboundStatusUnsubscribe();
      this.#outboundStatusUnsubscribe = null;
    }
    this.#queuedMessages = [];
    this.#queuedByInbox.clear();
    this.#queueTracking.clear();
    this.#ackPending.clear();
    await super.stop();
  }

  async listMessages(payload = {}) {
    const params = this._coerceParams(payload, ThreadMessagesListParams);
    const result = await this.#threadStore.listMessages({
      threadId: params.threadId,
      limit: params.limit,
      before: params.before,
    });
    const data = result && typeof result === "object" ? result : {};
    return new ThreadMessagesListResult({
      items: Array.isArray(data.items) ? data.items : Array.isArray(data.messages) ? data.messages : [],
      nextBefore: data.nextBefore && typeof data.nextBefore === "object" ? data.nextBefore : data.cursor,
    });
  }

  async sendMessage(payload = {}) {
    const params = this._coerceParams(payload, MessageSendParams);
    const threadId = params.threadId;
    const inReplyToMessageId = typeof params.inReplyToMessageId === "string" ? params.inReplyToMessageId.trim() : "";
    const channelId = typeof params.channelId === "string" ? params.channelId.trim() : "";
    const now = this.#clock();
    // TRUST-1: include a random component so a message's id is UNGUESSABLE. A
    // co-member must not be able to predict (and pre-seed/suppress) a future
    // message's id; the recipient-side sender-binding guard is the hard stop, this
    // removes the guess entirely.
    const messageId = params.messageId || ("local_" + now + "_" + randomUUID().slice(0, 8));
    // Idempotency on messageId. A resend (tap-to-retry on a failed bubble)
    // re-enters this method with the same messageId. recordOutboundDeposit
    // already overwrites the DB row in place via _upsertMessageUnlocked,
    // but the in-memory tracking maps still carry residue from the prior
    // attempt: a sticky anyDelivered flag on #queueTracking would block a
    // fresh "sent" transition; a leftover #ackPending entry would point
    // the next ack at the wrong attempt; a stale #queuedMessages entry
    // would duplicate on the next recovery sweep. Clear them here so the
    // attempt below runs as if this messageId is fresh.
    this.#discardQueueTracking(messageId);
    this.#ackPending.delete(messageId);
    this.#queuedMessages = this.#queuedMessages.filter((entry) => entry.messageId !== messageId);
    // Construct the canonical wire payload as a record. Self-contained:
    // body carries threadId/senderAccountId/messageId alongside the
    // kind-specific fields. Non-text payloads (e.g. images) come in
    // pre-built as objects with their own kind and pass through.
    // The optional `channelId` is a logical-organization tag (see
    // ChatMessagePayloadV1). Empty/missing = the implicit #general bucket.
    let wirePayload;
    if (params.payload && typeof params.payload === "object") {
      const base = {
        ...params.payload,
        threadId,
        senderAccountId: this.ownerAccountId,
        messageId,
      };
      if (inReplyToMessageId) base.inReplyToMessageId = inReplyToMessageId;
      // Top-level channelId wins over any value already on params.payload.
      if (channelId) base.channelId = channelId;
      wirePayload = base;
    } else {
      wirePayload = new ChatMessagePayloadV1({
        threadId,
        senderAccountId: this.ownerAccountId,
        messageId,
        text: String(params.payload || ""),
        inReplyToMessageId,
        channelId,
      }).toJSON();
    }
    const previewText = this.bus.services.threads.extractPreviewText(wirePayload);
    const packetB64 = JSON.stringify(wirePayload);

    if (threadId) {
      await this.#threadStore.recordOutboundDeposit({
        threadId,
        senderKey: this.ownerAccountId,
        messageId,
        senderAccountId: this.ownerAccountId,
        packetB64,
        acceptedAtMs: now,
        text: previewText,
        payload: wirePayload,
      }).catch((err) => {
        this.logger.error("[ServerMessagesService] outbound deposit persist failed", err && err.message ? err.message : err);
        this._emit("app.error", { source: "ServerMessagesService", message: "outbound deposit persist failed", severity: "error", err });
      });

      const indexRecord = await this.#threadIndex.upsertFromMessage({
        threadId,
        messageId,
        ts: now,
        preview: previewText,
        senderAccountId: this.ownerAccountId,
      }).catch((err) => {
        this.logger.error("[ServerMessagesService] outbound index upsert failed", err && err.message ? err.message : err);
        this._emit("app.error", { source: "ServerMessagesService", message: "outbound index upsert failed", severity: "warn", err });
      });
      if (indexRecord && this.bus.services && this.bus.services.threads) {
        this.bus.services.threads.emitThreadIndexUpdated(indexRecord);
      }

      this._emit("message.deposited", new MessageDepositedEvent({
        threadId,
        message: {
          messageId,
          threadId,
          senderAccountId: this.ownerAccountId,
          text: previewText,
          payload: wirePayload,
          status: "pending",
          createdAtMs: now,
          acceptedAtMs: now,
          inReplyToMessageId,
        },
      }));
    }

    const sdk = this.bus.runtime ? this.bus.runtime.sdk : null;
    const plaintextBodyBytes = new TextEncoder().encode(packetB64);
    let eventId = "";
    let messageQueued = false;
    let queuedInboxIds = [];
    // Every chat thread id is minted with a `th_` prefix (ServerThreadsService /
    // defaultRezConfig), so delivery always routes through #deliverToThread,
    // which seals per-recipient before handing opaque bytes to the mesh. There
    // is deliberately NO raw-mailbox path here: depositing plaintext straight to
    // a mailbox would violate Shape A (the node must never see plaintext).
    if (threadId && threadId.indexOf("th_") === 0) {
      const routed = await this.#deliverToThread({ threadId, plaintextBodyBytes, sdk, eventTag: messageId, now });
      eventId = routed.eventId;
      messageQueued = routed.queued;
      queuedInboxIds = Array.isArray(routed.queuedInboxIds) ? routed.queuedInboxIds : [];
    }

    if (threadId) {
      let nextStatus = "failed";
      if (eventId) {
        nextStatus = "sent";
        // Track in-flight so handleDeliveryAck can resolve the threadId
        // from the bare messageId on the ack wire.
        this.#ackPending.set(messageId, threadId);
      } else if (messageQueued) {
        nextStatus = "queued";
        this.#queuedMessages.push({ threadId, messageId, queuedAtMs: now });
        this.#trackQueuedMessage(threadId, messageId, queuedInboxIds);
      }
      await this.#threadStore.setMessageStatus({
        threadId,
        messageId,
        status: nextStatus,
        sentAtMs: eventId ? now : null,
      }).catch((err) => {
        this.logger.error("[ServerMessagesService] message status persist failed", err && err.message ? err.message : err);
      });
      this._emit("message.status", new MessageStatusEvent({
        threadId,
        messageId,
        status: nextStatus,
        sentAtMs: eventId ? now : null,
      }));
    }

    return new MessageSendResult({
      threadId,
      messageId,
      acceptedAtMs: now,
      packetB64,
    });
  }

  async editMessage(payload = {}) {
    const params = this._coerceParams(payload, MessageEditParams);
    const threadId = params.threadId;
    const target = params.targetMessageId;
    const editedAtMs = this.#clock();
    const applied = await this.#threadStore.applyEdit({
      threadId,
      targetMessageId: target,
      senderAccountId: this.ownerAccountId,
      newText: params.newText,
      editedAtMs,
      receivedAtMs: editedAtMs,
      allowBuffer: false,
    });
    this.#throwOnSenderRejection("editMessage", applied);
    if (applied && applied.message) {
      this.#emitMessageUpdated(threadId, applied.message);
    }
    const wirePayload = new ChatMessageEditPayloadV1({
      threadId,
      targetMessageId: target,
      newText: params.newText,
      senderAccountId: this.ownerAccountId,
      editedAtMs,
    }).toJSON();
    await this.#deliverMutationPayload({ threadId, wirePayload });
    return new MessageEditResult({ threadId, targetMessageId: target, editedAtMs });
  }

  async tombstoneMessage(payload = {}) {
    const params = this._coerceParams(payload, MessageTombstoneParams);
    const threadId = params.threadId;
    const target = params.targetMessageId;
    const tombstonedAtMs = this.#clock();
    const applied = await this.#threadStore.applyTombstone({
      threadId,
      targetMessageId: target,
      senderAccountId: this.ownerAccountId,
      tombstonedAtMs,
      receivedAtMs: tombstonedAtMs,
      allowBuffer: false,
    });
    this.#throwOnSenderRejection("tombstoneMessage", applied);
    if (applied && applied.message) {
      this.#emitMessageUpdated(threadId, applied.message);
    }
    const wirePayload = new ChatMessageTombstonePayloadV1({
      threadId,
      targetMessageId: target,
      senderAccountId: this.ownerAccountId,
      tombstonedAtMs,
    }).toJSON();
    await this.#deliverMutationPayload({ threadId, wirePayload });
    return new MessageTombstoneResult({ threadId, targetMessageId: target, tombstonedAtMs });
  }

  async deleteLocalMessage(payload = {}) {
    const params = this._coerceParams(payload, MessageDeleteLocalParams);
    const result = await this.#threadStore.applyLocalDelete({
      threadId: params.threadId,
      targetMessageId: params.targetMessageId,
    });
    if (result && result.removed) {
      this._emit("message.removed", new MessageRemovedEvent({
        threadId: params.threadId,
        messageId: params.targetMessageId,
      }));
    }
    return new MessageDeleteLocalResult({
      threadId: params.threadId,
      targetMessageId: params.targetMessageId,
      removed: !!(result && result.removed),
    });
  }

  async addReaction(payload = {}) {
    const params = this._coerceParams(payload, MessageReactionAddParams);
    return this.#sendReaction({
      threadId: params.threadId,
      targetMessageId: params.targetMessageId,
      emoji: params.emoji,
      op: "add",
    });
  }

  async removeReaction(payload = {}) {
    const params = this._coerceParams(payload, MessageReactionRemoveParams);
    return this.#sendReaction({
      threadId: params.threadId,
      targetMessageId: params.targetMessageId,
      emoji: params.emoji,
      op: "remove",
    });
  }

  async #sendReaction({ threadId, targetMessageId, emoji, op } = {}) {
    const createdAtMs = this.#clock();
    const wirePayload = new ChatReactionPayloadV1({
      threadId,
      targetMessageId,
      emoji,
      op,
      senderAccountId: this.ownerAccountId,
      createdAtMs,
    }).toJSON();
    const applied = await this.#threadStore.applyReaction({
      threadId,
      targetMessageId,
      senderAccountId: this.ownerAccountId,
      emoji,
      op,
      receivedAtMs: createdAtMs,
      allowBuffer: false,
    });
    if (applied && applied.message) {
      this.#emitMessageUpdated(threadId, applied.message);
    }
    await this.#deliverMutationPayload({ threadId, wirePayload });
    if (op === "add") {
      return new MessageReactionAddResult({ threadId, targetMessageId, emoji, createdAtMs });
    }
    return new MessageReactionRemoveResult({ threadId, targetMessageId, emoji, createdAtMs });
  }

  // Mutation handlers receive a validated payload record (see
  // PAYLOAD_KIND_REGISTRY in records/payloads/index.js — ServerEventService
  // constructs the record at the receive boundary). No re-parsing here.

  async handleIncomingEdit(record, ctx = {}) {
    if (!(record instanceof ChatMessageEditPayloadV1)) return false;
    const senderAccountId = typeof ctx.senderAccountId === "string" && ctx.senderAccountId.trim()
      ? ctx.senderAccountId.trim()
      : record.senderAccountId;
    const threadId = typeof ctx.threadId === "string" && ctx.threadId.trim()
      ? ctx.threadId.trim()
      : record.threadId;
    const result = await this.#threadStore.applyEdit({
      threadId,
      targetMessageId: record.targetMessageId,
      senderAccountId,
      newText: record.newText,
      editedAtMs: record.editedAtMs,
      receivedAtMs: this.#clock(),
      allowBuffer: true,
    });
    if (result && result.applied && result.message) {
      this.#emitMessageUpdated(threadId, result.message);
    } else if (result && result.rejected) {
      this.logger.warn("[ServerMessagesService] handleIncomingEdit rejected: " + result.reason);
    }
    return true;
  }

  async handleIncomingTombstone(record, ctx = {}) {
    if (!(record instanceof ChatMessageTombstonePayloadV1)) return false;
    const senderAccountId = typeof ctx.senderAccountId === "string" && ctx.senderAccountId.trim()
      ? ctx.senderAccountId.trim()
      : record.senderAccountId;
    const threadId = typeof ctx.threadId === "string" && ctx.threadId.trim()
      ? ctx.threadId.trim()
      : record.threadId;
    const result = await this.#threadStore.applyTombstone({
      threadId,
      targetMessageId: record.targetMessageId,
      senderAccountId,
      tombstonedAtMs: record.tombstonedAtMs,
      receivedAtMs: this.#clock(),
      allowBuffer: true,
    });
    if (result && result.applied && result.message) {
      this.#emitMessageUpdated(threadId, result.message);
    } else if (result && result.rejected) {
      this.logger.warn("[ServerMessagesService] handleIncomingTombstone rejected: " + result.reason);
    }
    return true;
  }

  async handleIncomingReaction(record, ctx = {}) {
    if (!(record instanceof ChatReactionPayloadV1)) return false;
    const senderAccountId = typeof ctx.senderAccountId === "string" && ctx.senderAccountId.trim()
      ? ctx.senderAccountId.trim()
      : record.senderAccountId;
    const threadId = typeof ctx.threadId === "string" && ctx.threadId.trim()
      ? ctx.threadId.trim()
      : record.threadId;
    const result = await this.#threadStore.applyReaction({
      threadId,
      targetMessageId: record.targetMessageId,
      senderAccountId,
      emoji: record.emoji,
      op: record.op,
      receivedAtMs: this.#clock(),
      allowBuffer: true,
    });
    if (result && result.applied && result.message) {
      this.#emitMessageUpdated(threadId, result.message);
    }
    return true;
  }

  #emitMessageUpdated(threadId, message) {
    if (!message) return;
    const record = message instanceof ChatMessage ? message : new ChatMessage({ ...message, threadId });
    this._emit("message.updated", new MessageUpdatedEvent({ threadId, message: record }));
  }

  #throwOnSenderRejection(op, applied) {
    if (!applied) return;
    if (applied.applied) return;
    const reason = typeof applied.reason === "string" ? applied.reason : "";
    // These three are legitimate no-ops on the sender side (local DB is
    // already the truth we'd want), so they don't throw. But log them so
    // we have a trace if they ever fire unexpectedly — silent skips have
    // historically masked real state-sync bugs.
    if (reason === "no_change" || reason === "stale" || reason === "already_tombstoned") {
      this.logger.warn("[ServerMessagesService] " + op + " no-op: " + reason);
      return;
    }
    if (reason === "target_not_found") {
      const err = new Error(op + ": target message not found");
      err.code = "MESSAGE_NOT_FOUND";
      throw err;
    }
    if (reason === "tombstoned") {
      const err = new Error(op + ": cannot edit a tombstoned message");
      err.code = "MESSAGE_TOMBSTONED";
      throw err;
    }
    if (reason === "unauthorized") {
      const err = new Error(op + ": not the author");
      err.code = "MESSAGE_NOT_AUTHOR";
      throw err;
    }
    const err = new Error(op + ": rejected (" + reason + ")");
    err.code = "MESSAGE_REJECTED";
    throw err;
  }

  /**
   * Shared deposit-routing for both `sendMessage` and mutation deliveries.
   * Resolves a `th_`-style thread to either group fan-out or DM cross-node
   * deposit. Returns `{eventId, queued, queuedInboxIds}` where
   * `queuedInboxIds` is the set of deliverInboxIds the node enqueued for
   * background retry (used to correlate later EVT_OUTBOUND_STATUS frames
   * back to this message).
   */
  async #deliverToThread({ threadId, plaintextBodyBytes, sdk, eventTag = "", now = Date.now() } = {}) {
    if (!threadId) return { eventId: "", queued: false, queuedInboxIds: [] };
    const thread = await this.#threadStore.getThread(threadId).catch(() => null);
    const threadType = thread && typeof thread.threadType === "string" ? thread.threadType : "";
    const threadGroupId = thread && typeof thread.groupId === "string" ? thread.groupId.trim() : "";
    const peerAccountId = thread && typeof thread.peerAccountId === "string" ? thread.peerAccountId.trim() : "";
    const peerInboxId = thread && typeof thread.peerInboxId === "string" ? thread.peerInboxId.trim() : "";
    const resolvedSdk = sdk || (this.bus.runtime ? this.bus.runtime.sdk : null);
    if (!resolvedSdk || typeof resolvedSdk.sealForPeer !== "function" || !resolvedSdk.mesh) {
      throw new Error("Cannot deliver to thread: sdk unavailable");
    }
    const localIdentity = typeof resolvedSdk.getIdentity === "function" ? resolvedSdk.getIdentity() : {};
    const localInboxId = typeof localIdentity.localInboxId === "string" ? localIdentity.localInboxId.trim() : "";
    if (threadType === "group" && threadGroupId) {
      try {
        const fanOut = await this.#sendGroupFanOut({
          sdk: resolvedSdk,
          groupId: threadGroupId,
          plaintextBodyBytes,
          localInboxId,
          messageId: eventTag,
        });
        if (fanOut.sentCount > 0) return { eventId: "gw:" + now + ":" + eventTag, queued: false, queuedInboxIds: [] };
        if (fanOut.queuedCount > 0) return { eventId: "", queued: true, queuedInboxIds: fanOut.queuedInboxIds };
        return { eventId: "", queued: false, queuedInboxIds: [] };
      } catch (err) {
        if (err && err.queued === true) return { eventId: "", queued: true, queuedInboxIds: [] };
        throw err;
      }
    }
    if (!peerInboxId) {
      throw new Error("Cannot deliver to peer-link thread without resolved binding target");
    }
    if (!peerAccountId) {
      throw new Error("Cannot deliver to peer-link thread: peer account not resolved");
    }
    try {
      // S2.5 Slice 5 — GATED per-device fan-out. When the E6 gate is open and
      // the peer published a device set, encrypt once per device and dispatch to
      // each device's inbox. Default (gate closed) returns null ⇒ the legacy
      // single-device sealForPeer below runs unchanged.
      const fanned = await this.#fanOutToPeerDevices({
        sdk: resolvedSdk,
        peerAccountId,
        plaintextBodyBytes,
        localInboxId,
        messageId: eventTag,
      });
      if (fanned) {
        if (fanned.sentCount > 0) return { eventId: "gw:" + now + ":" + eventTag, queued: false, queuedInboxIds: [] };
        if (fanned.queuedCount > 0) return { eventId: "", queued: true, queuedInboxIds: fanned.queuedInboxIds };
        return { eventId: "", queued: false, queuedInboxIds: [] };
      }

      // Seal the message for the peer (crypto + inbox resolution), then hand
      // the opaque object to the mesh. The creator names no transport.
      const sealed = await resolvedSdk.sealForPeer({
        peerAccountId: peerAccountId,
        plaintextBodyBytes,
        deliverInboxId: peerInboxId,
        receiptInboxId: localInboxId || undefined,
      });
      const result = await resolvedSdk.mesh.dispatch(
        sealed.object,
        sealed.address,
      );
      // Node-side gateway couldn't route synchronously but persisted the
      // deposit into PersistentOutboundQueue; RetryScheduler will keep
      // attempting delivery until success or 72h TTL expiry.
      if (result && result.queued === true) {
        const resolvedInbox = result && typeof result.mailboxId === "string" && result.mailboxId.trim().length > 0
          ? result.mailboxId.trim()
          : peerInboxId;
        return { eventId: "", queued: true, queuedInboxIds: resolvedInbox ? [resolvedInbox] : [] };
      }
      return { eventId: "gw:" + now + ":" + eventTag, queued: false, queuedInboxIds: [] };
    } catch (err) {
      // Defensive: an older node that surfaces queueing via thrown
      // err.queued instead of a successful queued response.
      if (err && err.queued === true) return { eventId: "", queued: true, queuedInboxIds: peerInboxId ? [peerInboxId] : [] };
      throw err;
    }
  }

  /**
   * S2.5 Slice 5 — GATED per-device fan-out. Encrypt the message once per
   * recipient DEVICE (own session) and dispatch to each device's own inbox.
   * Returns null (caller falls back to the legacy single-device sealForPeer)
   * UNLESS the E6 fan-out gate is open AND the peer published a resolvable
   * device set. The gate (`bus.runtime.multiDeviceFanout`) defaults closed and
   * flips at Slice 8 — so by default this is a no-op and the shipped path is
   * byte-for-byte unchanged.
   * @returns {Promise<{sentCount, queuedCount, queuedInboxIds, deviceCount}|null>}
   */
  async #fanOutToPeerDevices({ sdk, peerAccountId, plaintextBodyBytes, localInboxId, messageId = "" } = {}) {
    if (!this.bus.runtime || this.bus.runtime.multiDeviceFanout !== true) return null;
    if (!sdk || typeof sdk.sealForPeerDevice !== "function" || !sdk.mesh) return null;
    const peer = typeof peerAccountId === "string" ? peerAccountId.trim() : "";
    if (!peer) return null;

    let resolved = null;
    try {
      resolved = await this._call("device-set", "resolveForPeer", { peerAccountId: peer });
    } catch (err) {
      this.logger.error("[ServerMessagesService] device-set resolve failed", err && err.message ? err.message : err);
      return null;
    }
    const devices = resolved && resolved.deviceSetRecord && Array.isArray(resolved.deviceSetRecord.devices)
      ? resolved.deviceSetRecord.devices
      : [];
    if (devices.length === 0) return null;

    const handshakeByDevice = new Map();
    if (resolved && Array.isArray(resolved.established)) {
      for (const e of resolved.established) {
        if (e && typeof e.peerDeviceId === "string") handshakeByDevice.set(e.peerDeviceId, e.handshakeData);
      }
    }

    const cacheKeyFor = (deviceId) => (messageId ? messageId + "::" + deviceId : "");

    const results = await Promise.allSettled(devices.map(async (device) => {
      const peerDeviceId = device && typeof device.deviceId === "string" ? device.deviceId.trim() : "";
      const deliverInboxId = device && typeof device.inboxId === "string" ? device.inboxId.trim() : "";
      if (!peerDeviceId || !deliverInboxId) {
        throw new Error("device set entry missing deviceId/inboxId");
      }
      const cacheKey = cacheKeyFor(peerDeviceId);
      const cached = cacheKey ? this.#deviceFanoutCache.get(cacheKey) : null;
      // Already delivered on a prior attempt (Audit R2 #4): do NOT re-encrypt OR
      // re-dispatch. Re-dispatching identical ratchet bytes would double-advance
      // the recipient's receive ratchet and fail to decrypt — and re-encrypting
      // would advance OUR send ratchet a second time. Report it as already sent.
      if (cached && cached.deliveredOk) {
        return { alreadyDelivered: true };
      }
      // Reuse the ciphertext sealed on a prior (failed) attempt, else seal ONCE
      // and cache it — so the device ratchet advances exactly once for this
      // message no matter how many times the send is retried.
      let sealed = cached && cached.sealed ? cached.sealed : null;
      if (!sealed) {
        sealed = await sdk.sealForPeerDevice({
          peerAccountId: peer,
          peerDeviceId,
          deliverInboxId,
          plaintextBodyBytes,
          receiptInboxId: localInboxId || undefined,
          deviceHandshakeData: handshakeByDevice.has(peerDeviceId) ? handshakeByDevice.get(peerDeviceId) : null,
        });
        if (cacheKey) this.#cacheDeviceFanout(cacheKey, sealed);
      }
      const dispatch = await sdk.mesh.dispatch(sealed.object, sealed.address);
      return { dispatch, cacheKey };
    }));

    let sentCount = 0;
    let queuedCount = 0;
    let failedCount = 0;
    const queuedInboxIds = [];
    const failedReasons = [];
    for (const r of results) {
      if (r.status === "fulfilled") {
        const value = r.value || {};
        if (value.alreadyDelivered) { sentCount++; continue; }
        // Mark delivered so a later retry of this messageId skips the device.
        // A queued device is also "handled" — the node's PersistentOutboundQueue
        // retries it WITHOUT re-encryption, so the chat must not re-dispatch it.
        if (value.cacheKey) {
          const entry = this.#deviceFanoutCache.get(value.cacheKey);
          if (entry) entry.deliveredOk = true;
        }
        const dispatch = value.dispatch;
        if (dispatch && dispatch.queued === true) {
          queuedCount++;
          if (typeof dispatch.mailboxId === "string" && dispatch.mailboxId.trim().length > 0) {
            queuedInboxIds.push(dispatch.mailboxId.trim());
          }
        } else {
          sentCount++;
        }
      } else {
        failedCount++;
        const reason = r.reason && r.reason.message ? r.reason.message : String(r.reason);
        failedReasons.push(reason);
        this.logger.error("[ServerMessagesService] per-device send failed", reason);
      }
    }
    // A fan-out that could NOT reach every device is not a success — reporting
    // "sent" because one of N devices succeeded silently loses the message for
    // the others (Audit P1). A device that the node QUEUED (queued:true) is
    // retried by the node's PersistentOutboundQueue, but a device whose dispatch
    // THREW is not. So fail the whole send when any device threw: the caller's
    // send-failure path surfaces it + retries. The retry REPLAYS the cached
    // ciphertext only to the still-undelivered devices (Audit R2 #4) — delivered
    // devices are skipped and nothing is re-encrypted, so there is no double-
    // deliver and no extra ratchet advance. Mirrors the single-device path,
    // where a thrown dispatch fails the send.
    if (failedCount > 0) {
      const err = new Error("per-device fan-out incomplete: " + failedCount + "/" + devices.length
        + " device(s) failed (" + failedReasons.join("; ") + ")");
      err.code = "DEVICE_FANOUT_INCOMPLETE";
      err.failedCount = failedCount;
      err.deviceCount = devices.length;
      throw err;
    }
    return { sentCount, queuedCount, queuedInboxIds, deviceCount: devices.length };
  }

  /**
   * Cache one device's sealed ciphertext for replay on a send retry (Audit R2
   * #4). Bounded: a sweep of expired entries + FIFO eviction keeps this transient
   * in-flight state from growing without limit (entries are never persisted).
   */
  #cacheDeviceFanout(key, sealed) {
    const now = this.#clock();
    if (this.#deviceFanoutCache.size >= ServerMessagesService.#DEVICE_FANOUT_CACHE_MAX) {
      const ttl = ServerMessagesService.#DEVICE_FANOUT_CACHE_TTL_MS;
      for (const [k, v] of this.#deviceFanoutCache) {
        if (now - v.createdAtMs > ttl) this.#deviceFanoutCache.delete(k);
      }
      while (this.#deviceFanoutCache.size >= ServerMessagesService.#DEVICE_FANOUT_CACHE_MAX) {
        const oldest = this.#deviceFanoutCache.keys().next().value;
        if (oldest === undefined) break;
        this.#deviceFanoutCache.delete(oldest);
      }
    }
    this.#deviceFanoutCache.set(key, { sealed, deliveredOk: false, createdAtMs: now });
  }

  /**
   * Send to ONE group member. Identical to the legacy single-device path
   * (sealForPeer → dispatch) UNLESS the gated per-device fan-out applies, in
   * which case the per-device results are collapsed to one per-member outcome so
   * the group-fan-out accounting is unchanged.
   */
  async #sendToMember({ sdk, member, plaintextBodyBytes, localInboxId, messageId = "" } = {}) {
    const peerAccountId = member && typeof member.accountId === "string" ? member.accountId : "";
    const fanned = await this.#fanOutToPeerDevices({ sdk, peerAccountId, plaintextBodyBytes, localInboxId, messageId });
    if (fanned) {
      if (fanned.queuedCount > 0 && fanned.sentCount === 0) {
        return { queued: true, mailboxId: fanned.queuedInboxIds.length > 0 ? fanned.queuedInboxIds[0] : "" };
      }
      return { queued: false };
    }
    const sealed = await sdk.sealForPeer({
      peerAccountId,
      plaintextBodyBytes,
      receiptInboxId: localInboxId || undefined,
    });
    return sdk.mesh.dispatch(sealed.object, sealed.address);
  }

  async #deliverMutationPayload({ threadId, wirePayload } = {}) {
    if (!threadId || !wirePayload) return;
    const sdk = this.bus.runtime ? this.bus.runtime.sdk : null;
    if (!sdk) return;
    const plaintextBodyBytes = new TextEncoder().encode(JSON.stringify(wirePayload));
    await this.#deliverToThread({
      threadId,
      plaintextBodyBytes,
      sdk,
      eventTag: "mut-" + this.#clock(),
      now: this.#clock(),
    }).catch((err) => {
      this.logger.error("[ServerMessagesService] mutation delivery failed", err && err.message ? err.message : err);
    });
  }

  async handleDeliveryAck({ threadId, messageIds } = {}) {
    const id = typeof threadId === "string" ? threadId.trim() : "";
    const items = Array.isArray(messageIds) ? messageIds : [];
    if (items.length === 0) return;
    const now = this.#clock();
    for (const item of items) {
      const messageId = typeof item === "string" ? item.trim() : "";
      if (!messageId) continue;
      const queuedEntry = this.#queuedMessages.find((entry) => entry && entry.messageId === messageId);
      const pendingThreadId = this.#ackPending.get(messageId);
      const resolvedThreadId = id
        || (queuedEntry && typeof queuedEntry.threadId === "string" ? queuedEntry.threadId : "")
        || (typeof pendingThreadId === "string" ? pendingThreadId : "");
      if (!resolvedThreadId) continue;
      await this.#threadStore.setMessageStatus({
        threadId: resolvedThreadId,
        messageId,
        status: "delivered",
        acceptedAtMs: now,
      }).catch((err) => {
        this.logger.error("[ServerMessagesService] delivery ack status persist failed", err && err.message ? err.message : err);
        this._emit("app.error", { source: "ServerMessagesService", message: "delivery ack status persist failed", severity: "error", err });
      });
      this.#queuedMessages = this.#queuedMessages.filter((entry) => !(entry.threadId === resolvedThreadId && entry.messageId === messageId));
      this.#ackPending.delete(messageId);
      this.#discardQueueTracking(messageId);
      this._emit("message.status", new MessageStatusEvent({
        threadId: resolvedThreadId,
        messageId,
        status: "delivered",
        acceptedAtMs: now,
      }));
    }
  }

  async #sendGroupFanOut({ sdk, groupId, plaintextBodyBytes, localInboxId, messageId = "" } = {}) {
    if (!sdk || typeof sdk.sealForPeer !== "function" || !sdk.mesh) {
      throw new Error("sendGroupFanOut: sdk unavailable");
    }
    const members = await this.#groupStore.listMembers({
      ownerAccountId: this.ownerAccountId,
      groupId,
    });
    const targets = [];
    for (const member of members) {
      if (member.state !== "active") continue;
      if (member.accountId === this.ownerAccountId) continue;
      targets.push(member);
    }
    if (targets.length === 0) {
      return { sentCount: 0, failedCount: 0, skippedCount: 0, queuedCount: 0, queuedInboxIds: [] };
    }
    // S2.5 Slice 5 — each member send goes through #sendToMember, which is the
    // legacy single-device sealForPeer path UNLESS the E6 fan-out gate is open
    // and the member published a device set (then it fans out per device and
    // collapses to one per-member outcome). Gate closed ⇒ identical to before.
    const results = await Promise.allSettled(
      targets.map((member) => this.#sendToMember({ sdk, member, plaintextBodyBytes, localInboxId, messageId })),
    );
    // Sender-side recovery: a message handed to the mesh for a co-member is now
    // expected to come back as an end-to-end delivery-ack. Record it per recipient
    // so a peer whose link is desynced (never acks) gets re-invited. The recipient
    // is known EXACTLY here (the send side), which the opaque recipient-side path
    // can't do for a node with multiple peer-links. See ServerPeerLinkProtocolService.
    const peerLinkProtocol = this.bus.services && this.bus.services.peerLinkProtocol
      ? this.bus.services.peerLinkProtocol
      : null;
    let sentCount = 0;
    let failedCount = 0;
    let skippedCount = 0;
    let queuedCount = 0;
    const queuedInboxIds = [];
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const target = targets[i];
      if (result.status === "fulfilled") {
        // A queued resolution means the node persisted the deposit into
        // PersistentOutboundQueue but couldn't synchronously route. Count
        // it as queued, not sent — the message will deliver via the node's
        // RetryScheduler on the next route appearance or 15s tick.
        if (result.value && result.value.queued === true) {
          queuedCount++;
          if (result.value && typeof result.value.mailboxId === "string" && result.value.mailboxId.trim().length > 0) {
            queuedInboxIds.push(result.value.mailboxId.trim());
          }
        } else {
          sentCount++;
        }
        // Sent or queued — both reach the relay buffer and warrant an ack.
        if (peerLinkProtocol && typeof peerLinkProtocol.recordOutboundGroupMessage === "function"
            && target && typeof target.accountId === "string") {
          peerLinkProtocol.recordOutboundGroupMessage({ peerAccountId: target.accountId });
        }
        continue;
      }
      const err = result.reason;
      if (err && err.queued === true) {
        queuedCount++;
      } else if (err && (err.code === "NO_DELIVERY_TARGET" || err.code === "THREAD_NOT_READY")) {
        skippedCount++;
      } else {
        failedCount++;
        this.logger.error("[ServerMessagesService] group fan-out send failed", err && err.message ? err.message : err);
      }
    }
    return { sentCount, failedCount, skippedCount, queuedCount, queuedInboxIds };
  }

  // Recovery sweeps DB rows still in "queued" state. The node's
  // PersistentOutboundQueue is the authoritative scheduler from here on
  // — for messages still within 72h, we let future EVT_OUTBOUND_STATUS
  // frames drive the next transition. For DM threads we also rebuild
  // the deliverInboxId tracking from the thread record so post-restart
  // status frames correlate cleanly. Rows whose age already exceeds
  // 72h are marked failed at boot as a safety net (node may have
  // already expired and signaled while the chat-server was offline).
  async #recoverQueuedMessages() {
    const now = this.#clock();
    const threadIds = await this.#threadStore.listThreadIds();
    for (const threadId of threadIds) {
      const result = await this.#threadStore.listMessages({ threadId, limit: 500 }).catch(() => null);
      const items = result && Array.isArray(result.items) ? result.items : [];
      let thread = null;
      let threadLoaded = false;
      for (const message of items) {
        if (!message || message.status !== "queued") continue;
        const age = now - (message.createdAtMs || 0);
        if (age > ServerMessagesService.QUEUE_TTL_MS) {
          await this.#threadStore.setMessageStatus({
            threadId,
            messageId: message.messageId,
            status: "failed",
          }).catch((err) => {
            this.logger.error("[ServerMessagesService] recovery status persist failed", err && err.message ? err.message : err);
            this._emit("app.error", { source: "ServerMessagesService", message: "recovery status persist failed", severity: "warn", err });
          });
          this._emit("message.status", new MessageStatusEvent({
            threadId,
            messageId: message.messageId,
            status: "failed",
          }));
          continue;
        }
        const queuedAtMs = message.createdAtMs || now;
        this.#queuedMessages.push({
          threadId,
          messageId: message.messageId,
          queuedAtMs,
        });
        if (!threadLoaded) {
          thread = await this.#threadStore.getThread(threadId).catch(() => null);
          threadLoaded = true;
        }
        const threadType = thread && typeof thread.threadType === "string" ? thread.threadType : "";
        const peerInboxId = thread && typeof thread.peerInboxId === "string" ? thread.peerInboxId.trim() : "";
        // DM tracking is rebuildable from the thread record. Group
        // tracking requires per-member peer-link lookup; we skip it
        // here and accept that pre-restart group-queued messages
        // transition only via the receiver-side E2EE delivery ack
        // (or the next boot's age-expiry safety net above).
        if (threadType === "direct" && peerInboxId) {
          this.#trackQueuedMessage(threadId, message.messageId, [peerInboxId]);
        }
      }
    }
  }

  #trackQueuedMessage(threadId, messageId, inboxIds) {
    if (!Array.isArray(inboxIds) || inboxIds.length === 0) return;
    let tracking = this.#queueTracking.get(messageId);
    if (!tracking) {
      tracking = { threadId, outstandingInboxIds: new Set(), anyDelivered: false };
      this.#queueTracking.set(messageId, tracking);
    }
    for (const raw of inboxIds) {
      if (typeof raw !== "string") continue;
      const inboxId = raw.trim();
      if (!inboxId) continue;
      tracking.outstandingInboxIds.add(inboxId);
      let set = this.#queuedByInbox.get(inboxId);
      if (!set) {
        set = new Set();
        this.#queuedByInbox.set(inboxId, set);
      }
      set.add(messageId);
    }
  }

  #discardQueueTracking(messageId) {
    const tracking = this.#queueTracking.get(messageId);
    if (!tracking) return;
    for (const inboxId of tracking.outstandingInboxIds) {
      const set = this.#queuedByInbox.get(inboxId);
      if (!set) continue;
      set.delete(messageId);
      if (set.size === 0) this.#queuedByInbox.delete(inboxId);
    }
    this.#queueTracking.delete(messageId);
  }

  async #handleOutboundStatus(body = {}) {
    const deliverInboxId = typeof body.deliverInboxId === "string" ? body.deliverInboxId.trim() : "";
    const status = typeof body.status === "string" ? body.status.trim() : "";
    if (!deliverInboxId) return;
    if (status !== "delivered" && status !== "expired") return;
    const messageIds = this.#queuedByInbox.get(deliverInboxId);
    if (!messageIds || messageIds.size === 0) {
      if (messageIds) this.#queuedByInbox.delete(deliverInboxId);
      return;
    }
    const now = this.#clock();
    const snapshot = Array.from(messageIds);
    for (const messageId of snapshot) {
      await this.#applyOutboundStatusToMessage({ messageId, deliverInboxId, status, now });
    }
    const remaining = this.#queuedByInbox.get(deliverInboxId);
    if (remaining && remaining.size === 0) {
      this.#queuedByInbox.delete(deliverInboxId);
    }
  }

  async #applyOutboundStatusToMessage({ messageId, deliverInboxId, status, now }) {
    const inboxSet = this.#queuedByInbox.get(deliverInboxId);
    if (inboxSet) inboxSet.delete(messageId);
    const tracking = this.#queueTracking.get(messageId);
    if (!tracking) return;
    tracking.outstandingInboxIds.delete(deliverInboxId);

    if (status === "delivered" && !tracking.anyDelivered) {
      tracking.anyDelivered = true;
      await this.#threadStore.setMessageStatus({
        threadId: tracking.threadId,
        messageId,
        status: "sent",
        sentAtMs: now,
      }).catch((err) => {
        this.logger.error("[ServerMessagesService] outbound status sent persist failed", err && err.message ? err.message : err);
        this._emit("app.error", { source: "ServerMessagesService", message: "outbound status sent persist failed", severity: "error", err });
      });
      this.#ackPending.set(messageId, tracking.threadId);
      this.#queuedMessages = this.#queuedMessages.filter((entry) => entry.messageId !== messageId);
      this._emit("message.status", new MessageStatusEvent({
        threadId: tracking.threadId,
        messageId,
        status: "sent",
        sentAtMs: now,
      }));
    } else if (status === "expired" && !tracking.anyDelivered && tracking.outstandingInboxIds.size === 0) {
      await this.#threadStore.setMessageStatus({
        threadId: tracking.threadId,
        messageId,
        status: "failed",
      }).catch((err) => {
        this.logger.error("[ServerMessagesService] outbound status failed persist failed", err && err.message ? err.message : err);
        this._emit("app.error", { source: "ServerMessagesService", message: "outbound status failed persist failed", severity: "error", err });
      });
      this.#queuedMessages = this.#queuedMessages.filter((entry) => entry.messageId !== messageId);
      this._emit("message.status", new MessageStatusEvent({
        threadId: tracking.threadId,
        messageId,
        status: "failed",
      }));
    }

    if (tracking.outstandingInboxIds.size === 0) {
      this.#queueTracking.delete(messageId);
    }
  }
}
