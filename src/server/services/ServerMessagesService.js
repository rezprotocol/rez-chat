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
  MESSAGE_KIND,
  MESSAGE_EDIT_KIND,
  MESSAGE_TOMBSTONE_KIND,
  REACTION_KIND,
} from "../../records/payloads/index.js";
import {
  signableOriginalMessageBytes,
  messageFingerprint,
} from "../../records/payloads/originalMessageShapes.js";
import {
  MessageCommitAckV1,
  verifyCommitAckForAcceptance,
} from "../../records/payloads/MessageCommitAckV1.js";
import { BaseServerService } from "../base/BaseServerService.js";
import { runtimeUuid, bytesToBase64 } from "@rezprotocol/sdk/client";

// MessageCommitAck retry policy (plans/MESSAGE_COMMIT_ACK_PLAN.md §7
// decision 5): FIXED internal constants — aggressive bounded exponential
// backoff for roughly the first hour, then a capped SLOW TAIL forever. A
// pending commit is never declared failed purely on time; a verified ack is
// the only terminal success, and event triggers (reconnect, boot) may sweep
// earlier. Jitter keeps multiple clients from synchronizing retries.
const COMMIT_RETRY_SCHEDULE_MS = [5_000, 15_000, 45_000, 120_000, 300_000, 900_000];
const COMMIT_RETRY_SLOW_TAIL_MS = 20 * 60_000;
const COMMIT_RETRY_JITTER_FRAC = 0.25;

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
  // AE-1: this runtime's account-authority signer (resolved lazily, once —
  // mode/keys/chain are fixed for a boot) and a short-TTL authority-epoch
  // cache. Null signer = a runtime without the signing machinery (minimal
  // embeddings) that emits legacy unsigned payloads.
  #originalSignerPromise = null;
  #epochCache = null;
  // DURABLE per-(messageId, peerDeviceId) sealed-ciphertext cache (injected
  // DeviceFanoutCacheStore) for gated per-device fan-out. Re-encrypting a device
  // on a send retry advances that device's ratchet AGAIN — duplicating to
  // already-delivered devices and burning the failed device's skip tolerance. So
  // we encrypt ONCE per device per message and, on a retry of the SAME messageId,
  // replay the identical bytes ONLY to devices not yet delivered. Persisting it
  // means a retry AFTER A SENDER RESTART (recovery re-send) replays too, instead
  // of re-encrypting from a fresh ratchet position. Audit R2 #4 + R3 #4.
  #deviceFanoutStore;
  // MessageCommitAck (decision 4): the ADVISORY sweep timer. It only triggers
  // re-evaluation — retry eligibility always derives from the DURABLE
  // pending-commit rows + the clock, so losing the timer (restart) loses
  // nothing: start()/reconnect re-derive the schedule from the rows.
  #commitSweepTimer = null;
  #commitSweepRunning = false;
  // Set by stop(): an in-flight #scheduleCommitSweep must not re-arm the
  // timer after the service shut down (orphan-timer race).
  #commitSweepStopped = false;

  constructor({
    bus,
    threadStore,
    threadIndex,
    groupStore,
    deviceFanoutStore,
    ownerAccountId,
    clock = () => Date.now(),
    logger = console,
  } = {}) {
    super({ bus, ownerAccountId, logger });
    if (!threadStore || !threadIndex || !groupStore) {
      throw new Error("ServerMessagesService requires thread/index/group stores");
    }
    if (!deviceFanoutStore || typeof deviceFanoutStore.get !== "function") {
      throw new Error("ServerMessagesService requires a deviceFanoutStore");
    }
    this.#threadStore = threadStore;
    this.#threadIndex = threadIndex;
    this.#groupStore = groupStore;
    this.#deviceFanoutStore = deviceFanoutStore;
    this.#clock = clock;
    this.#queuedMessages = [];
    this._register("thread.messages", "list", (payload) => this.listMessages(payload));
    this._register("message", "send", (payload) => this.sendMessage(payload));
    this._register("message", "edit", (payload) => this.editMessage(payload));
    this._register("message", "tombstone", (payload) => this.tombstoneMessage(payload));
    this._register("message", "deleteLocal", (payload) => this.deleteLocalMessage(payload));
    this._register("message.reaction", "add", (payload) => this.addReaction(payload));
    this._register("message.reaction", "remove", (payload) => this.removeReaction(payload));
    this._register("message.commit", "sweep", (payload) => this.sweepPendingCommits(payload || {}));
  }

  async start() {
    this.#commitSweepStopped = false;
    await this.#recoverQueuedMessages().catch((err) => {
      this.logger.error("[ServerMessagesService] queued message recovery failed", err && err.message ? err.message : err);
    });
    // Best-effort: sweep device-fanout cache entries that aged out while the
    // process was down so the durable store can't accumulate them.
    await this.#deviceFanoutStore.prune().catch((err) => {
      this.logger.error("[ServerMessagesService] device-fanout cache prune failed", err && err.message ? err.message : err);
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
    // Deterministic restart resume (decision 4): pending-commit rows are
    // durable, so boot re-derives the retry schedule from them — anything
    // already due sweeps now, the rest re-arms the advisory timer. Best-effort
    // here (the runtime may not be connected yet); the reconnect trigger
    // sweeps again once connectivity lands.
    this.sweepPendingCommits({}).catch((err) => {
      this.logger.error("[ServerMessagesService] boot pending-commit sweep failed", err && err.message ? err.message : err);
    });
  }

  async stop() {
    this.#commitSweepStopped = true;
    if (this.#commitSweepTimer) {
      clearTimeout(this.#commitSweepTimer);
      this.#commitSweepTimer = null;
    }
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

  // ── AE-1: OriginalMessage signing (plan §2/§7) ─────────────────────────────
  // ONE helper covers all four wire-payload build sites. Dual-mode via the
  // SDK's accountAuthoritySigner(): the account root B signs directly on a
  // primary, the device key C signs under the capability chain on a
  // delegated device.
  //
  // The cutover boundary (Noah's AE-1 close ruling) distinguishes:
  //   SIGNING_UNAVAILABLE_BY_CONFIGURATION — this runtime has no signing
  //     machinery at all (no bus.runtime.peerLinks / no signer seam:
  //     minimal embeddings, legacy tests) → legacy unsigned emission.
  //   SIGNING_EXPECTED_BUT_BROKEN — the machinery exists but the signer
  //     fails to resolve (or, below, fails to sign) → the send/mutation
  //     FAILS. A full runtime must never quietly leave authenticated
  //     history through an error path.

  async #originalSigner() {
    const peerLinks = this.bus.runtime && this.bus.runtime.peerLinks ? this.bus.runtime.peerLinks : null;
    if (!peerLinks || typeof peerLinks.accountAuthoritySigner !== "function") return null;
    if (!this.#originalSignerPromise) {
      const resolving = peerLinks.accountAuthoritySigner();
      this.#originalSignerPromise = resolving;
      // A failed resolution must not be cached forever: clear it so a
      // transient boot-order failure can recover on the next attempt.
      resolving.catch(() => {
        if (this.#originalSignerPromise === resolving) this.#originalSignerPromise = null;
      });
    }
    try {
      return await this.#originalSignerPromise;
    } catch (err) {
      const reason = err && err.message ? err.message : String(err);
      this.logger.error("[ServerMessagesService] account-authority signer failed to resolve; refusing to emit an unsigned fact", reason);
      this._emit("app.error", {
        source: "ServerMessagesService",
        message: "account-authority signer failed to resolve; send refused",
        severity: "error",
        err,
      });
      const failure = new Error("account-authority signer failed to resolve; refusing to emit an unsigned fact: " + reason);
      failure.code = "SIGNING_EXPECTED_BUT_BROKEN";
      throw failure;
    }
  }

  // The epoch stamp is signed ORDERING/AUDIT data — admission never trusts a
  // record's claimed epoch (rev4 Q4: revocation is forward-looking at the
  // receiver) — so an unreadable authority state degrades to 0, loudly.
  async #authorityEpoch() {
    const now = this.#clock();
    if (this.#epochCache && (now - this.#epochCache.atMs) < 60000) return this.#epochCache.epoch;
    let epoch = 0;
    const sdk = this.bus.runtime ? this.bus.runtime.sdk : null;
    if (sdk && sdk.devices && typeof sdk.devices.getAuthorityState === "function") {
      try {
        const state = await sdk.devices.getAuthorityState();
        epoch = state && Number.isInteger(state.epoch) && state.epoch >= 0 ? state.epoch : 0;
      } catch (err) {
        this.logger.warn("[ServerMessagesService] authority epoch unavailable; stamping 0",
          err && err.message ? err.message : err);
      }
    }
    this.#epochCache = { epoch, atMs: now };
    return epoch;
  }

  /**
   * Build + sign one OriginalMessage wire payload. Two-phase: a draft record
   * first COERCES the semantic fields (trim/int rules), the canonical bytes
   * are built from the COERCED JSON, then the final record carries the
   * envelope (chain/contentHash/sig) — so the bytes the receiver recomputes
   * from the wire JSON are byte-identical to what was signed. Returns null
   * when this runtime has no signer (legacy unsigned emission); THROWS when
   * a resolved signer fails to sign — never a silent downgrade.
   */
  async #signOriginalPayload(RecordClass, semanticFields) {
    const signer = await this.#originalSigner();
    if (!signer) return null;
    const draft = new RecordClass({
      ...semanticFields,
      signerPublicKeyB64: signer.signerPublicKeyB64,
      senderDeviceId: typeof signer.senderDeviceId === "string" ? signer.senderDeviceId : "",
      senderAuthorityEpoch: await this.#authorityEpoch(),
    }).toJSON();
    const signableBytes = signableOriginalMessageBytes(draft);
    const contentHash = messageFingerprint(draft);
    const sigB64 = bytesToBase64(await signer.sign(signableBytes));
    return new RecordClass({
      ...draft,
      senderCertChain: Array.isArray(signer.certChain) ? signer.certChain : [],
      contentHash,
      sig: sigB64,
    }).toJSON();
  }

  /**
   * Record this device's OWN signed fact into the immutable per-thread log
   * (local origin — no admission verify; we authored it). Same error posture
   * as the outbound projection persist: log + app.error, never blocks the
   * send.
   */
  async #recordLocalOriginalFact({ threadId, wirePayload, now }) {
    const contentHash = wirePayload && typeof wirePayload.contentHash === "string" ? wirePayload.contentHash.trim() : "";
    if (!threadId || !contentHash) return;
    await this.#threadStore.appendOriginalFact({
      threadId,
      fact: { fingerprint: contentHash, payload: wirePayload, receivedAtMs: now, origin: "local" },
    }).catch((err) => {
      this.logger.error("[ServerMessagesService] local original-fact persist failed", err && err.message ? err.message : err);
      this._emit("app.error", { source: "ServerMessagesService", message: "local original-fact persist failed", severity: "error", err });
    });
  }

  /**
   * Resolve the `targetFingerprint` a signed mutation binds to (the plan's
   * BINDING requirement — messageId is not a unique fact identity).
   *   - exactly one base fact for the (sender, messageId) identity → bind it
   *   - none → an unsigned-era target: the mutation is emitted as a legacy
   *     UNSIGNED payload (pre-cutover history stays in the legacy world)
   *   - more than one → the target is integrity-conflicted; there is no
   *     cryptographic basis for choosing WHICH fact to mutate — fail loud.
   */
  async #resolveTargetFingerprint({ threadId, targetMessageId, targetSenderAccountId = null } = {}) {
    const facts = await this.#threadStore.findBaseFactsByMessageId({
      threadId,
      messageId: targetMessageId,
      senderAccountId: targetSenderAccountId,
    });
    if (facts.length === 0) return "";
    if (facts.length > 1) {
      const err = new Error("target message '" + targetMessageId + "' is integrity-conflicted; a mutation cannot name which fact it mutates");
      err.code = "MESSAGE_TARGET_CONFLICTED";
      throw err;
    }
    return typeof facts[0].fingerprint === "string" ? facts[0].fingerprint : "";
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
    const messageId = params.messageId || ("local_" + now + "_" + runtimeUuid().slice(0, 8));
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
    const objectPayload = params.payload && typeof params.payload === "object" ? params.payload : null;
    const objectKind = objectPayload && typeof objectPayload.kind === "string" ? objectPayload.kind : "";
    if (objectPayload && objectKind && objectKind !== MESSAGE_KIND) {
      // Non-primary kinds (images, etc.) pass through as before — they are
      // not OriginalMessages in AE-1's scope.
      const base = {
        ...objectPayload,
        threadId,
        senderAccountId: this.ownerAccountId,
        messageId,
      };
      if (inReplyToMessageId) base.inReplyToMessageId = inReplyToMessageId;
      // Top-level channelId wins over any value already on params.payload.
      if (channelId) base.channelId = channelId;
      wirePayload = base;
    } else {
      // The primary chat message (the UI sends it as {kind, text, ...}).
      // AE-1 hard cutover: a runtime with the account-authority signer emits
      // the SIGNED OriginalMessage; only signerless embeddings stay legacy.
      // Top-level inReplyToMessageId/channelId win over the payload's
      // (unchanged precedence).
      const semantic = {
        threadId,
        senderAccountId: this.ownerAccountId,
        messageId,
        text: objectPayload && typeof objectPayload.text === "string"
          ? objectPayload.text
          : String(params.payload || ""),
        inReplyToMessageId: inReplyToMessageId
          || (objectPayload && typeof objectPayload.inReplyToMessageId === "string" ? objectPayload.inReplyToMessageId.trim() : ""),
        channelId: channelId
          || (objectPayload && typeof objectPayload.channelId === "string" ? objectPayload.channelId.trim() : ""),
      };
      const signed = await this.#signOriginalPayload(ChatMessagePayloadV1, semantic);
      wirePayload = signed || new ChatMessagePayloadV1(semantic).toJSON();
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

      await this.#recordLocalOriginalFact({ threadId, wirePayload, now });

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
    let sentToGroup = false;
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
      sentToGroup = routed.isGroup === true;
    }

    if (threadId) {
      let nextStatus = "failed";
      if (eventId) {
        nextStatus = "sent";
        // Track in-flight so handleDeliveryAck can resolve the threadId
        // from the bare messageId on the ack wire. DT-004: group messageIds
        // are deliberately NOT registered — group members now ack (so the
        // sender-side recovery evidence in ServerPeerLinkProtocolService is
        // truthful), but a group row's status must not flip to "delivered"
        // on the first of N member acks; group acks feed recovery only.
        if (!sentToGroup) {
          this.#ackPending.set(messageId, threadId);
        }
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
      // MessageCommitAck (plan §3): a SIGNED 1:1 send that reached the mesh
      // (or the node's durable queue) opens a durable pending-commit row —
      // "delivered" is now a proof, and this row is what the verified ack
      // consumes. Group sends stay evidence-only (DT-004: a group row never
      // flips on the first of N member acks). A failed send stays with the
      // user-visible failed/tap-to-retry path, not the ack-repair loop.
      const signedFingerprint = wirePayload && typeof wirePayload.contentHash === "string"
        ? wirePayload.contentHash.trim() : "";
      if (signedFingerprint && !sentToGroup && (nextStatus === "sent" || nextStatus === "queued")) {
        await this.#openPendingCommit({ threadId, messageId, fingerprint: signedFingerprint, now });
      }
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
    // AE-1: bind the signed mutation to the target FACT's fingerprint (only
    // the author may edit, so the target identity is (owner, target)). An
    // unsigned-era target ("" fingerprint) stays a legacy unsigned mutation.
    const targetFingerprint = await this.#resolveTargetFingerprint({
      threadId,
      targetMessageId: target,
      targetSenderAccountId: this.ownerAccountId,
    });
    const editSemantic = {
      threadId,
      targetMessageId: target,
      newText: params.newText,
      senderAccountId: this.ownerAccountId,
      editedAtMs,
    };
    let wirePayload = null;
    if (targetFingerprint) {
      wirePayload = await this.#signOriginalPayload(ChatMessageEditPayloadV1, { ...editSemantic, targetFingerprint });
    }
    if (!wirePayload) wirePayload = new ChatMessageEditPayloadV1(editSemantic).toJSON();
    await this.#recordLocalOriginalFact({ threadId, wirePayload, now: editedAtMs });
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
    // AE-1: same fingerprint binding as editMessage (author-only mutation).
    const targetFingerprint = await this.#resolveTargetFingerprint({
      threadId,
      targetMessageId: target,
      targetSenderAccountId: this.ownerAccountId,
    });
    const tombstoneSemantic = {
      threadId,
      targetMessageId: target,
      senderAccountId: this.ownerAccountId,
      tombstonedAtMs,
    };
    let wirePayload = null;
    if (targetFingerprint) {
      wirePayload = await this.#signOriginalPayload(ChatMessageTombstonePayloadV1, { ...tombstoneSemantic, targetFingerprint });
    }
    if (!wirePayload) wirePayload = new ChatMessageTombstonePayloadV1(tombstoneSemantic).toJSON();
    await this.#recordLocalOriginalFact({ threadId, wirePayload, now: tombstonedAtMs });
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
    // AE-1: a reaction may target ANOTHER account's message — disambiguate
    // the fact identity by the target row's authenticated author when the
    // local apply resolved it.
    const targetSender = applied && applied.message && typeof applied.message.senderAccountId === "string"
      && applied.message.senderAccountId.trim()
      ? applied.message.senderAccountId.trim()
      : null;
    const targetFingerprint = await this.#resolveTargetFingerprint({
      threadId,
      targetMessageId,
      targetSenderAccountId: targetSender,
    });
    const reactionSemantic = {
      threadId,
      targetMessageId,
      emoji,
      op,
      senderAccountId: this.ownerAccountId,
      createdAtMs,
    };
    let wirePayload = null;
    if (targetFingerprint) {
      wirePayload = await this.#signOriginalPayload(ChatReactionPayloadV1, { ...reactionSemantic, targetFingerprint });
    }
    if (!wirePayload) wirePayload = new ChatReactionPayloadV1(reactionSemantic).toJSON();
    await this.#recordLocalOriginalFact({ threadId, wirePayload, now: createdAtMs });
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
        if (fanOut.sentCount > 0) return { eventId: "gw:" + now + ":" + eventTag, queued: false, queuedInboxIds: [], isGroup: true };
        if (fanOut.queuedCount > 0) return { eventId: "", queued: true, queuedInboxIds: fanOut.queuedInboxIds, isGroup: true };
        return { eventId: "", queued: false, queuedInboxIds: [], isGroup: true };
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
    // Gate CLOSED (the default) — every exit below is `return null`, i.e. the legacy
    // single-device path, byte-for-byte unchanged.
    if (!this.bus.runtime || this.bus.runtime.multiDeviceFanout !== true) return null;

    // Gate OPEN (P1#4). From here a `return null` means "deliver to ONE device", and doing that
    // when the peer actually has several silently drops the message for every other device — the
    // recipient sees nothing on the device they happen to be using and no one is told. So an
    // UNKNOWN device set must FAIL, loudly, and let the caller retry or queue. Only one thing
    // still legitimately falls back: a peer that has published no device set at all.
    if (!sdk || typeof sdk.sealForPeerDevice !== "function" || !sdk.mesh) {
      throw new Error(
        "ServerMessagesService: multi-device fan-out is enabled but the SDK cannot seal per-device"
          + " (sealForPeerDevice/mesh missing) — refusing to downgrade to a single-device send",
      );
    }
    const peer = typeof peerAccountId === "string" ? peerAccountId.trim() : "";
    if (!peer) {
      throw new Error("ServerMessagesService: multi-device fan-out requires a resolved peerAccountId");
    }

    let resolved = null;
    try {
      resolved = await this._call("device-set", "resolveForPeer", { peerAccountId: peer });
    } catch (err) {
      // We do not know the peer's device set. That is precisely when a downgrade is unsafe.
      const reason = err && err.message ? err.message : String(err);
      this.logger.error("[ServerMessagesService] device-set resolve failed for " + peer + ": " + reason);
      throw new Error(
        "ServerMessagesService: device-set resolution failed for " + peer
          + " while fan-out is enabled — refusing to downgrade to a single-device send: " + reason,
      );
    }
    // null = the peer has published NO device set (a single-device or pre-multi-device peer).
    // That is a real answer, not a failure: the legacy path is the correct delivery for them.
    if (resolved === null || resolved === undefined) return null;

    const devices = resolved.deviceSetRecord && Array.isArray(resolved.deviceSetRecord.devices)
      ? resolved.deviceSetRecord.devices
      : null;
    if (devices === null || devices.length === 0) {
      // A resolved-but-empty set is self-contradictory: the peer published a device set that
      // names no device to deliver to. Never guess which single device that meant.
      throw new Error(
        "ServerMessagesService: peer " + peer + " resolved to a device set with no devices"
          + " while fan-out is enabled — refusing to downgrade to a single-device send",
      );
    }

    const handshakeByDevice = new Map();
    if (resolved && Array.isArray(resolved.established)) {
      for (const e of resolved.established) {
        if (e && typeof e.peerDeviceId === "string") handshakeByDevice.set(e.peerDeviceId, e.handshakeData);
      }
    }

    // The cache slot is the full (owner, peer, message, device) tuple (Audit R4
    // #7) — never messageId::deviceId alone — so no two owners/peers/messages
    // collide. A messageId-less send is uncacheable (coords null ⇒ no replay).
    const coordsFor = (deviceId) => (messageId && deviceId
      ? { ownerAccountId: this.ownerAccountId, peerAccountId: peer, messageId, peerDeviceId: deviceId }
      : null);

    const results = await Promise.allSettled(devices.map(async (device) => {
      const peerDeviceId = device && typeof device.deviceId === "string" ? device.deviceId.trim() : "";
      const deliverInboxId = device && typeof device.inboxId === "string" ? device.inboxId.trim() : "";
      if (!peerDeviceId || !deliverInboxId) {
        throw new Error("device set entry missing deviceId/inboxId");
      }
      const coords = coordsFor(peerDeviceId);
      const cached = coords ? await this.#deviceFanoutStore.get(coords) : null;
      // Already delivered on a prior attempt (Audit R2 #4): do NOT re-encrypt OR
      // re-dispatch. Re-dispatching identical ratchet bytes would double-advance
      // the recipient's receive ratchet and fail to decrypt — and re-encrypting
      // would advance OUR send ratchet a second time. Report it as already sent.
      if (cached && cached.deliveredOk) {
        return { alreadyDelivered: true };
      }
      // Reuse the ciphertext sealed on a prior (failed) attempt — durably, so
      // even a retry after a sender restart replays it (Audit R3 #4) — else seal
      // ONCE and persist it, so the device ratchet advances exactly once for this
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
        if (coords) await this.#deviceFanoutStore.put(coords, sealed);
      }
      const dispatch = await sdk.mesh.dispatch(sealed.object, sealed.address);
      return { dispatch, coords };
    }));

    let sentCount = 0;
    let queuedCount = 0;
    let failedCount = 0;
    const queuedInboxIds = [];
    const failedReasons = [];
    const delivered = [];
    for (const r of results) {
      if (r.status === "fulfilled") {
        const value = r.value || {};
        if (value.alreadyDelivered) { sentCount++; continue; }
        // Mark delivered so a later retry of this messageId skips the device.
        // A queued device is also "handled" — the node's PersistentOutboundQueue
        // retries it WITHOUT re-encryption, so the chat must not re-dispatch it.
        // Persisted below (after the loop) so the skip survives a sender restart.
        if (value.coords) delivered.push(value.coords);
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
    // Persist the delivered marks BEFORE any incomplete-fan-out throw: a partial
    // fan-out throws to trigger a retry, and the retry must skip the devices that
    // already succeeded (durably, so a sender restart between attempts still
    // skips them) rather than re-encrypt + re-deliver to them.
    for (const coords of delivered) {
      await this.#deviceFanoutStore.markDelivered(coords);
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
      // Hard cutover by message regime (plan §7 decision 1): a SIGNED send's
      // "delivered" is a PROOF carried only by a verified MessageCommitAck.
      // A legacy delivery ack for a message with an open pending-commit row
      // (e.g. from a signerless recipient runtime) is transport evidence
      // only — it was already counted for link recovery — and must not flip
      // the status; the retry loop keeps running until real proof arrives.
      const pendingCommit = await this.#threadStore.getPendingCommit({ messageId });
      if (pendingCommit) {
        this.logger.warn("[ServerMessagesService] legacy delivery ack for signed message "
          + messageId + " ignored for status; awaiting MessageCommitAck proof");
        continue;
      }
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

  // ── MessageCommitAck (plans/MESSAGE_COMMIT_ACK_PLAN.md) ───────────────────

  /**
   * Build + sign the recipient-side commit proof for one admitted-and-
   * committed OriginalMessage (called by ServerEventService at the T1 site,
   * AFTER the projection commit). Returns the wire JSON, or null when this
   * runtime has no signing machinery (SIGNING_UNAVAILABLE_BY_CONFIGURATION —
   * the caller falls back to the legacy delivery ack). THROWS when the
   * resolved signer breaks (SIGNING_EXPECTED_BUT_BROKEN): a false commit
   * claim is never emitted.
   */
  async buildCommitAck({ messageId, messageFingerprint: fingerprint, threadId, committedAtMs } = {}) {
    const signer = await this.#originalSigner();
    if (!signer) return null;
    const semantic = {
      messageId,
      messageFingerprint: fingerprint,
      threadId,
      recipientAccountId: this.ownerAccountId,
      recipientDeviceId: typeof signer.senderDeviceId === "string" ? signer.senderDeviceId : "",
      recipientAuthorityEpoch: await this.#authorityEpoch(),
      signerPublicKeyB64: signer.signerPublicKeyB64,
      committedAtMs,
    };
    const sigB64 = bytesToBase64(await signer.sign(MessageCommitAckV1.signableBytes(semantic)));
    return new MessageCommitAckV1({
      ...semantic,
      recipientCertChain: Array.isArray(signer.certChain) ? signer.certChain : [],
      sig: sigB64,
    }).toJSON();
  }

  /**
   * Inbound commit ack (registry dispatch — always consumed). EVIDENCE,
   * admitted fail-closed per the frozen distinction (plan §8): malformed /
   * wrong-signature / wrong-fingerprint / revoked-signer acks are rejected;
   * an unavailable recipient authority source leaves the ack UNCONSUMED (the
   * retry loop continues — never "unknown authority state means probably
   * okay"); only a VERIFIED ack consumes the pending commit. Idempotent by
   * fingerprint: any valid proof — including one from a recipient sibling
   * outside the original fan-out (decision 2) — is the same terminal
   * condition, and later duplicates are harmless.
   */
  async handleCommitAck(record, ctx = {}) {
    if (!(record instanceof MessageCommitAckV1)) return false;
    const authedSender = typeof ctx.senderAccountId === "string" ? ctx.senderAccountId.trim() : "";
    // Any ack that decrypted off the sealed channel proves the us→peer
    // direction lives — the same recovery evidence the legacy ack carries at
    // the transport layer (decision 1 rider). Recorded before verification,
    // keyed ONLY by the envelope-authenticated sender.
    const peerLinkProtocol = this.bus.services && this.bus.services.peerLinkProtocol
      ? this.bus.services.peerLinkProtocol : null;
    if (authedSender && peerLinkProtocol && typeof peerLinkProtocol.noteAckEvidence === "function") {
      peerLinkProtocol.noteAckEvidence({ peerAccountId: authedSender });
    }
    // REZ-7 analog: the commit claim must come from the account that makes
    // it — a peer must not clear ANOTHER peer's pending commit by naming
    // them in the payload.
    if (!authedSender || record.recipientAccountId !== authedSender) {
      this.logger.warn("[ServerMessagesService] commit-ack recipient mismatch (claimed "
        + record.recipientAccountId + " != authenticated " + (authedSender || "<none>") + "); ignoring");
      return true;
    }

    // Step 1 — the claim must name a fact WE authored. The pending row is
    // the primary lookup; without one (duplicate proof after consume, group
    // ack, or an ack racing the row write) the claim is re-derived from our
    // own originals log — absent there, we never sent this.
    const pending = await this.#threadStore.getPendingCommit({ messageId: record.messageId });
    if (pending) {
      if (record.messageFingerprint !== pending.fingerprint || record.threadId !== pending.threadId) {
        // Exactly the divergence rev6 wanted visible: the recipient claims a
        // commit of DIFFERENT content under our messageId.
        this.logger.warn("[ServerMessagesService] commit-ack claim mismatch for " + record.messageId
          + " (fingerprint/thread does not match the pending claim) — divergence evidence; ignoring");
        return true;
      }
      if (pending.recipientAccountId !== authedSender) {
        this.logger.warn("[ServerMessagesService] commit-ack for " + record.messageId
          + " from " + authedSender + " but pending recipient is " + pending.recipientAccountId + "; ignoring");
        return true;
      }
    } else {
      const fact = await this.#threadStore.getOriginalFact({
        threadId: record.threadId,
        fingerprint: record.messageFingerprint,
      });
      const factSender = fact && typeof fact.senderAccountId === "string" ? fact.senderAccountId : "";
      const factMessageId = fact && typeof fact.messageId === "string" ? fact.messageId : "";
      if (!fact || factSender !== this.ownerAccountId || factMessageId !== record.messageId) {
        this.logger.warn("[ServerMessagesService] commit-ack names no outbound fact of ours ("
          + record.messageId + "); ignoring");
        return true;
      }
    }

    // Steps 2–5 — fail-closed acceptance (self-certifying recipient identity,
    // deviceId self-cert, signature, verifyAccountAuthority with CURRENT
    // revocation state). A direct-mode ack carries no revocable credential;
    // a cert-mode ack requires an ESTABLISHED revocation source.
    const runtimePeerLinks = this.bus.runtime && this.bus.runtime.peerLinks ? this.bus.runtime.peerLinks : null;
    const cryptoProvider = runtimePeerLinks && runtimePeerLinks.cryptoProvider ? runtimePeerLinks.cryptoProvider : null;
    if (!cryptoProvider) {
      this.logger.warn("[ServerMessagesService] no cryptoProvider; commit ack for "
        + record.messageId + " left unconsumed");
      return true;
    }
    const chain = Array.isArray(record.recipientCertChain) && record.recipientCertChain.length > 0
      ? record.recipientCertChain : null;
    let revocationState = null;
    if (chain) {
      const source = await this.#peerRevocationStateFor(authedSender);
      if (!source.ok) {
        this.logger.warn("[ServerMessagesService] commit ack for " + record.messageId
          + " left unconsumed: " + source.reason);
        return true;
      }
      revocationState = source.revocationState;
    }
    const verdict = await verifyCommitAckForAcceptance({
      ackJson: record.toJSON(),
      cryptoProvider,
      nowMs: this.#clock(),
      revocationState,
    });
    if (!verdict.ok) {
      this.logger.warn("[ServerMessagesService] rejected commit ack for " + record.messageId
        + ": " + verdict.reason);
      return true;
    }

    // Terminal success: consume the pending commit and make "delivered" the
    // proof it now is (decision 3). Group rows never flip on a member ack
    // (DT-004); the evidence above is their whole consumption.
    const resolvedThreadId = pending ? pending.threadId : record.threadId;
    if (pending) {
      await this.#threadStore.deletePendingCommit({ messageId: record.messageId });
      this.#scheduleCommitSweep();
    }
    const thread = await this.#threadStore.getThread(resolvedThreadId).catch(() => null);
    if (thread && thread.threadType !== "group") {
      const now = this.#clock();
      await this.#threadStore.setMessageStatus({
        threadId: resolvedThreadId,
        messageId: record.messageId,
        status: "delivered",
        acceptedAtMs: now,
      }).catch((err) => {
        this.logger.error("[ServerMessagesService] commit-ack status persist failed", err && err.message ? err.message : err);
        this._emit("app.error", { source: "ServerMessagesService", message: "commit-ack status persist failed", severity: "error", err });
      });
      this.#queuedMessages = this.#queuedMessages.filter((entry) => !(entry.threadId === resolvedThreadId && entry.messageId === record.messageId));
      this.#ackPending.delete(record.messageId);
      this.#discardQueueTracking(record.messageId);
      this._emit("message.status", new MessageStatusEvent({
        threadId: resolvedThreadId,
        messageId: record.messageId,
        status: "delivered",
        acceptedAtMs: this.#clock(),
      }));
    }
    return true;
  }

  /**
   * Sweep the durable pending-commit rows: every row whose nextRetryAtMs has
   * passed is retried (invalidate DeviceSet → re-resolve fresh → re-fan-out
   * the EXACT same OriginalMessage — same messageId, same fingerprint, cached
   * ciphertexts replayed so no device ratchet ever advances twice). Triggered
   * by boot, reconnect, the advisory timer, and the on-demand directive;
   * `force` retries every row regardless of schedule (tests/diagnostics).
   */
  async sweepPendingCommits({ force = false } = {}) {
    if (this.#commitSweepRunning) return { swept: 0, pending: -1, busy: true };
    this.#commitSweepRunning = true;
    try {
      const rows = await this.#threadStore.listPendingCommits();
      const now = this.#clock();
      let swept = 0;
      for (const row of rows) {
        // A non-finite schedule stamp means "due now" — `now >= NaN` is
        // false, and treating it as not-due would stall the row forever
        // (the frozen NaN fail-open lesson).
        const dueAt = Number.isFinite(row.nextRetryAtMs) ? row.nextRetryAtMs : 0;
        if (force !== true && now < dueAt) continue;
        try {
          await this.#retryPendingCommit(row);
          swept += 1;
        } catch (err) {
          this.logger.error("[ServerMessagesService] pending-commit retry failed for " + row.messageId,
            err && err.message ? err.message : err);
        }
      }
      return { swept, pending: rows.length };
    } finally {
      this.#commitSweepRunning = false;
      this.#scheduleCommitSweep();
    }
  }

  async #openPendingCommit({ threadId, messageId, fingerprint, now } = {}) {
    try {
      const thread = await this.#threadStore.getThread(threadId);
      const recipientAccountId = thread && thread.threadType !== "group"
        && typeof thread.peerAccountId === "string" ? thread.peerAccountId.trim() : "";
      if (!recipientAccountId) return;
      await this.#threadStore.putPendingCommit({
        messageId,
        threadId,
        fingerprint,
        recipientAccountId,
        firstSentAtMs: now,
        attempts: 0,
        nextRetryAtMs: now + this.#commitRetryDelayMs(0),
      });
      this.#scheduleCommitSweep();
    } catch (err) {
      // The send already happened; a tracking fault must be loud, never fatal.
      this.logger.error("[ServerMessagesService] pending-commit open failed for " + messageId,
        err && err.message ? err.message : err);
      this._emit("app.error", { source: "ServerMessagesService", message: "pending-commit open failed", severity: "error", err });
    }
  }

  async #retryPendingCommit(row) {
    const fact = await this.#threadStore.getOriginalFact({ threadId: row.threadId, fingerprint: row.fingerprint });
    if (!fact || !fact.payload || typeof fact.payload !== "object") {
      // A claim whose immutable fact vanished is unrepairable — drop VISIBLY,
      // never stall silently.
      this.logger.error("[ServerMessagesService] pending commit " + row.messageId
        + " has no originals-log fact; dropping the row");
      await this.#threadStore.deletePendingCommit({ messageId: row.messageId });
      return;
    }
    const now = this.#clock();
    const attempts = (Number.isInteger(row.attempts) && row.attempts >= 0 ? row.attempts : 0) + 1;
    // Persist the schedule step BEFORE dispatching so a crash mid-attempt
    // backs off on resume instead of hot-looping the same row.
    await this.#threadStore.putPendingCommit({
      messageId: row.messageId,
      threadId: row.threadId,
      fingerprint: row.fingerprint,
      recipientAccountId: row.recipientAccountId,
      firstSentAtMs: row.firstSentAtMs,
      attempts,
      lastAttemptAtMs: now,
      nextRetryAtMs: now + this.#commitRetryDelayMs(attempts),
    });
    // Stale-DeviceSet repair (plan §3): drop the cached recipient set so the
    // deliver path re-resolves fresh; newly-enrolled devices get fresh seals,
    // already-delivered devices replay from the durable fan-out cache.
    if (this.bus.functions && this.bus.functions["device-set"]) {
      try {
        await this._call("device-set", "invalidate", { peerAccountId: row.recipientAccountId });
      } catch (err) {
        this.logger.warn("[ServerMessagesService] device-set invalidate failed for " + row.recipientAccountId,
          err && err.message ? err.message : err);
      }
    }
    const plaintextBodyBytes = new TextEncoder().encode(JSON.stringify(fact.payload));
    try {
      await this.#deliverToThread({
        threadId: row.threadId,
        plaintextBodyBytes,
        sdk: this.bus.runtime ? this.bus.runtime.sdk : null,
        eventTag: row.messageId,
        now,
      });
    } catch (err) {
      // The row already carries its next schedule step; a failed attempt just
      // waits for it.
      this.logger.warn("[ServerMessagesService] pending-commit re-fan-out failed for " + row.messageId,
        err && err.message ? err.message : err);
    }
  }

  #commitRetryDelayMs(attempts) {
    const n = Number.isInteger(attempts) && attempts >= 0 ? attempts : 0;
    const base = n < COMMIT_RETRY_SCHEDULE_MS.length ? COMMIT_RETRY_SCHEDULE_MS[n] : COMMIT_RETRY_SLOW_TAIL_MS;
    return base + Math.floor(base * COMMIT_RETRY_JITTER_FRAC * Math.random());
  }

  // Re-arm the ADVISORY timer from the durable rows (never the other way
  // around). Fire-and-forget by design; scheduling faults are logged.
  #scheduleCommitSweep() {
    const run = async () => {
      if (this.#commitSweepStopped) return;
      const rows = await this.#threadStore.listPendingCommits();
      if (this.#commitSweepTimer) {
        clearTimeout(this.#commitSweepTimer);
        this.#commitSweepTimer = null;
      }
      if (this.#commitSweepStopped || rows.length === 0) return;
      const now = this.#clock();
      let earliest = Infinity;
      for (const row of rows) {
        const at = Number.isFinite(row.nextRetryAtMs) ? row.nextRetryAtMs : now;
        if (at < earliest) earliest = at;
      }
      const delay = Math.max(earliest - now, 1000);
      this.#commitSweepTimer = setTimeout(() => {
        this.#commitSweepTimer = null;
        this.sweepPendingCommits({}).catch((err) => {
          this.logger.error("[ServerMessagesService] scheduled pending-commit sweep failed",
            err && err.message ? err.message : err);
        });
      }, delay);
    };
    run().catch((err) => {
      this.logger.error("[ServerMessagesService] pending-commit sweep scheduling failed",
        err && err.message ? err.message : err);
    });
  }

  // The canonical peer revocation source availability wrapper (the AE-2
  // pattern): {ok:false} = COULD NOT ESTABLISH — the caller must defer, never
  // assume-allowed; {ok:true, revocationState:null} = established, nothing
  // revoked (a real answer). The source itself is ServerAccountMutationService
  // (SSOT); a disabled service answers null indistinguishably from
  // "no revocations", so availability is checked BEFORE asking.
  async #peerRevocationStateFor(peerAccountId) {
    const accountMutation = this.bus.services && this.bus.services.accountMutation
      ? this.bus.services.accountMutation : null;
    if (!accountMutation
        || typeof accountMutation.isEnabled !== "function"
        || typeof accountMutation.getPeerRevocationState !== "function"
        || !accountMutation.isEnabled()) {
      return { ok: false, reason: "peer revocation source unavailable" };
    }
    try {
      const revocationState = await accountMutation.getPeerRevocationState({ peerAccountId });
      return { ok: true, revocationState };
    } catch (err) {
      return { ok: false, reason: "peer revocation fetch failed: " + (err && err.message ? err.message : "unknown") };
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
