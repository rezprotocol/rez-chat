import {
  MessageDepositedEvent,
  PeerLinkUpdatedEvent,
} from "../../records/index.js";
import { getPayloadEntry, GROUP_OP_KIND } from "../../records/payloads/index.js";
import { MESSAGE_KIND as CHAT_MESSAGE_KIND } from "../../records/payloads/ChatMessagePayloadV1.js";
import { E2eeDeliveryAckV1 } from "@rezprotocol/sdk/client";
import { BaseServerService } from "../base/BaseServerService.js";

export class ServerEventService extends BaseServerService {
  #clock;
  // Decrypted group messages whose authenticated sender is not YET an active
  // member — held (keyed `groupId:accountId`) instead of dropped, then re-applied
  // when that member's member.join lands (flushDeferredGroupMessages). Fixes the
  // offline race where a message is push-delivered before its sender's join op,
  // which the fail-closed authz gate would otherwise drop permanently. Bounded
  // by key count + per-key depth. In-memory (the live offline path re-delivers
  // both the message and the join into the same chat-server session). See memory
  // project_offline_push_before_handshake_race.
  #deferredGroupMessages;
  #redeliveringDeferred;
  #maxDeferredKeys;
  #maxDeferredPerKey;

  constructor({ bus, ownerAccountId, clock = () => Date.now(), logger = console, maxDeferredKeys = 256, maxDeferredPerKey = 64 } = {}) {
    super({ bus, ownerAccountId, logger });
    this.#clock = clock;
    this.#deferredGroupMessages = new Map();
    this.#redeliveringDeferred = false;
    this.#maxDeferredKeys = Number.isInteger(maxDeferredKeys) && maxDeferredKeys > 0 ? maxDeferredKeys : 256;
    this.#maxDeferredPerKey = Number.isInteger(maxDeferredPerKey) && maxDeferredPerKey > 0 ? maxDeferredPerKey : 64;
  }

  async start() {
    // Inbound deposit application is NOT event-driven. Processing a deposit is
    // a directive that must complete-and-confirm before the next deposit is
    // touched (catch-up ordering correctness — see InboundDepositPipeline and
    // memory feedback_inbound_deposit_pipeline_must_be_awaited_calls). The
    // pipeline calls processDeposit()/applyUserMessage() directly and awaits
    // them, in order; we therefore do NOT subscribe to the deposit/user-message
    // bus events here. Peer-link snapshots + delivery acks remain true
    // notifications (react-if-you-care), so they stay as bus subscriptions.
    this.bus.on("peerlink.protocol.snapshot", (event) => this.#handlePeerLinkUpdated({ body: event }));
    this.bus.on("delivery.ack", (event) => this.#handleDeliveryAck({ body: event }));
  }

  /**
   * Apply a raw inbound deposit (plaintext app deposits; E2EE bodies are
   * decrypted upstream by ServerPeerLinkProtocolService and applied via
   * {@link applyUserMessage}). Awaitable directive — the inbound pipeline
   * awaits this to completion before processing the next deposit.
   */
  async processDeposit(event) {
    return this.#handleMailboxDeposited(event);
  }

  /**
   * Apply a decrypted E2EE user message (plaintext + authenticated sender)
   * surfaced by ServerPeerLinkProtocolService.processDeposit. Awaitable
   * directive — feeds the same apply core as a plaintext deposit.
   */
  async applyUserMessage(data) {
    return this.#handlePeerlinkUserMessage(data);
  }

  async #handlePeerLinkUpdated(event) {
    const frame = event && typeof event === "object" ? event : {};
    const body = frame.body && typeof frame.body === "object" ? frame.body : frame;
    let threadId = typeof body.threadId === "string" ? body.threadId : null;
    const peerAccountId = typeof body.peerAccountId === "string" ? body.peerAccountId : null;
    const peerInboxId = typeof body.peerInboxId === "string" ? body.peerInboxId : null;
    const remoteDisplayName = typeof body.remoteDisplayName === "string" ? body.remoteDisplayName : "";
    const now = this.#clock();
    let threadReady = true;

    const peerLinkId = typeof body.peerLinkId === "string" ? body.peerLinkId : "";

    // Peer-link snapshots are pure crypto plumbing — they materialize the
    // direct-thread record, contact, and trigger the profile send. Group
    // membership is established by the explicit `member.join` op handled
    // by ServerGroupsService; do NOT touch group state here.
    if (body.state === "established" || body.state === "session_established") {
      if (peerAccountId) {
        if (!threadId && this.bus.services.threads && typeof this.bus.services.threads.directThreadIdForPeerLink === "function") {
          threadId = this.bus.services.threads.directThreadIdForPeerLink(peerLinkId, peerAccountId);
        }
        await this.bus.services.threads.ensureDirectThread({
          threadId,
          peerAccountId,
          peerInboxId,
          createdAtMs: now,
        }).catch((err) => {
          threadReady = false;
          this.logger.error("[ServerEventService] peer-link thread persist failed", err && err.message ? err.message : err);
        });
        const directIndexRecord = await this.bus.stores.threadIndex.upsertFromMessage({
          threadId,
          messageId: null,
          ts: now,
          preview: "Connected",
        }).catch((err) => {
          this.logger.error("[ServerEventService] direct index upsert failed", err && err.message ? err.message : err);
          this._emit("app.error", { source: "ServerEventService", message: "direct index upsert failed", severity: "warn", err });
        });
        if (directIndexRecord) {
          this.bus.services.threads.emitThreadIndexUpdated(directIndexRecord);
        }
      }
      if (peerAccountId) {
        await this.bus.services.contacts.ensureActiveContact({
          accountId: peerAccountId,
          displayName: remoteDisplayName,
          lastSeenAtMs: now,
        }).catch((err) => {
          this.logger.error("[ServerEventService] contact ensure failed", err && err.message ? err.message : err);
          this._emit("app.error", { source: "ServerEventService", message: "contact ensure failed", severity: "warn", err });
        });
      }
      if (peerAccountId && this.bus.services.profile && typeof this.bus.services.profile.sendProfileToPeer === "function") {
        this.bus.services.profile.sendProfileToPeer({
          peerAccountId,
          threadId,
          peerInboxId,
        }).catch((err) => {
          this.logger.error("[ServerEventService] profile send to new peer failed", err && err.message ? err.message : err);
        });
      }
    }

    // Rollback: the inviter's handshake responder rejected this acceptor
    // (invite used up / expired) and the SDK rolled the peer-link back to
    // "rejected". Tear down the optimistic state acceptInvite created so the
    // user isn't left looking at a contact/conversation that will never work.
    if (body.state === "rejected" && peerAccountId) {
      if (this.bus.services.threads && typeof this.bus.services.threads.directThreadIdForPeerLink === "function") {
        const rejectedThreadId = threadId
          || this.bus.services.threads.directThreadIdForPeerLink(peerLinkId, peerAccountId);
        if (rejectedThreadId) {
          await this.bus.services.threads.deleteThread({ threadId: rejectedThreadId }).catch((err) => {
            this.logger.error("[ServerEventService] rejected peer-link thread delete failed", err && err.message ? err.message : err);
          });
        }
      }
      if (this.bus.services.contacts && typeof this.bus.services.contacts.deleteContact === "function") {
        await this.bus.services.contacts.deleteContact({ accountId: peerAccountId }).catch((err) => {
          this.logger.error("[ServerEventService] rejected peer-link contact delete failed", err && err.message ? err.message : err);
        });
      }
      // A rejected GROUP invite leaves an optimistic group thread that can never
      // deliver (no session to the inviter). Tear down exactly the group joined
      // via THIS invite (bound to the one invite, not everything the inviter
      // set up). activeInviteId is the peer-link's invite — group-agnostic
      // boundary preserved (no groupId on the snapshot).
      const rejectedInviteId = typeof body.activeInviteId === "string" ? body.activeInviteId : "";
      if (rejectedInviteId && this.bus.services.groups && typeof this.bus.services.groups.discardGroupForRejectedInvite === "function") {
        await this.bus.services.groups.discardGroupForRejectedInvite({ inviteId: rejectedInviteId }).catch((err) => {
          this.logger.error("[ServerEventService] rejected peer-link group teardown failed", err && err.message ? err.message : err);
        });
      }
    }

    if (!threadReady) return;
    const record = new PeerLinkUpdatedEvent({
      peerLinkId: typeof body.peerLinkId === "string" ? body.peerLinkId : "",
      threadId,
      state: typeof body.state === "string" ? body.state : "",
      peerAccountId,
      sessionState: typeof body.sessionState === "string" ? body.sessionState : null,
      lastErrorMessage: typeof body.lastErrorMessage === "string" ? body.lastErrorMessage : null,
    });
    this._emit("runtime.event.peer-link.updated", record);
    this._emit("peer-link.updated", record);
  }

  async #handleMailboxDeposited(event) {
    const frame = event && typeof event === "object" ? event : {};
    const body = frame.body && typeof frame.body === "object" ? frame.body : frame;
    const eventId = typeof body.eventId === "string" ? body.eventId.trim() : "";
    const mailboxId = typeof body.mailboxId === "string" ? body.mailboxId.trim() : "";
    const ciphertextB64 = typeof body.ciphertextB64 === "string" ? body.ciphertextB64 : "";
    // Envelope-level sender (decrypted snapshot from peer-link). Used as
    // authoritative fallback when the payload itself lacks senderAccountId
    // (e.g. group ops, channel ops).
    const envelopeSender = typeof body.senderAccountId === "string" ? body.senderAccountId.trim() : "";

    if (!eventId) {
      return;
    }

    // Skip E2EE / peer-link protocol bodies — those are routed by
    // ServerPeerLinkProtocolService. We process only plaintext app-level
    // deposits here. (After Shape A activation, peerlink-protocol service
    // emits a `peerlink.user.message` event that we handle separately.)
    if (ciphertextB64) {
      try {
        const raw = Buffer.from(ciphertextB64, "base64").toString("utf8");
        const peek = JSON.parse(raw);
        if (peek && typeof peek === "object" && !Array.isArray(peek)) {
          const kind = typeof peek.kind === "string" ? peek.kind : "";
          if (peek.e2ee === 1
              || kind === "rez.peerlink.claim.req"
              || kind === "rez.peerlink.claim.res"
              || kind === "rez.peerlink.handshake.ack.v2") {
            return;
          }
        }
      } catch {
        // not JSON — fall through; treat as opaque preview payload
      }
    }

    // No dispatch-layer dedup. Downstream persistence is idempotent by
    // canonical key (messageId, groupOpId, channelId, etc.). Re-dispatching
    // a duplicate is cheap; silently dropping a legitimate retransmission
    // (relay retry, late join replay) is a real bug. DB is source of truth.

    let decodedPayload = null;
    let previewText = "";
    if (ciphertextB64) {
      try {
        const raw = Buffer.from(ciphertextB64, "base64").toString("utf8");
        const parsed = JSON.parse(raw);
        decodedPayload = parsed && typeof parsed === "object" ? parsed : null;
        previewText = this.bus.services.threads.extractPreviewText(decodedPayload);
      } catch {
        // ignore malformed preview payloads
      }
    }

    let threadId = decodedPayload && typeof decodedPayload.threadId === "string"
      ? decodedPayload.threadId.trim()
      : "";
    let thread = null;
    const payloadSender = decodedPayload && typeof decodedPayload.senderAccountId === "string"
      ? decodedPayload.senderAccountId.trim() : "";
    if (threadId) {
      thread = await this.bus.stores.threadStore.getThread(threadId).catch(() => null);
      if (!thread) {
        threadId = "";
      }
    }
    if (!thread && payloadSender) {
      const resolved = await this.#resolveDirectThreadForSender({
        senderAccountId: payloadSender,
        createdAtMs: this.#clock(),
      });
      if (resolved && resolved.threadId && resolved.thread) {
        threadId = resolved.threadId;
        thread = resolved.thread;
      }
    }
    const peerAcct = thread && typeof thread.peerAccountId === "string" ? thread.peerAccountId.trim() : "";

    // SECURITY — authoritative group-content authorization (audit pass 5, H1).
    // Before ANY group content is dispatched (reactions/edits/tombstones/media),
    // persisted (messages), or rendered, the sender MUST be an active member of
    // the target group. The only trustworthy sender identity is `envelopeSender`
    // — the account from the decrypted peer-link snapshot (cryptographically
    // authenticated). The payload's self-declared `senderAccountId` is NOT
    // trusted for group threads (it is attacker-controllable). Group-management
    // ops (GroupOpPayloadV1) self-authorize inside handleIncomingGroupOp
    // (member.join is the bootstrap exception), so they are exempt here. Fail
    // closed: an unauthenticated or non-active sender is dropped.
    const inboundKind = decodedPayload && typeof decodedPayload.kind === "string" ? decodedPayload.kind : "";
    if (thread && thread.threadType === "group" && inboundKind !== GROUP_OP_KIND) {
      const groupId = typeof thread.groupId === "string" ? thread.groupId.trim() : "";
      const authedSender = envelopeSender;
      const membership = groupId && authedSender
        ? await this.bus.stores.groupStore.getMembership({
            ownerAccountId: this.ownerAccountId,
            groupId,
            accountId: authedSender,
          }).catch(() => null)
        : null;
      if (!membership || String(membership.state || "").toLowerCase() !== "active") {
        // The sender is cryptographically authenticated (envelopeSender from the
        // decrypted peer-link snapshot) but we have not processed their
        // member.join YET — the message was delivered ahead of the join. DEFER
        // (not drop): hold the decrypted event and re-apply it when the join
        // activates this sender. This does NOT weaken the gate — delivery still
        // requires active membership; it is only deferred until the authorizing
        // op arrives. A sender with no authenticated identity is still dropped,
        // and a message re-applied from a flush that STILL fails the gate is
        // dropped (never re-deferred — the #redeliveringDeferred guard).
        // Defer ONLY a brand-new authenticated sender we have NO membership
        // record for yet (their member.join simply hasn't been processed). A
        // sender whose membership exists but is non-active (e.g. "removed"/
        // kicked) is NOT a pending joiner — drop it, so a later re-admission can
        // never resurrect a message they sent while removed.
        if (!membership && authedSender && groupId && !this.#redeliveringDeferred) {
          this.#deferGroupMessage(groupId, authedSender, event);
          return;
        }
        this.logger.warn("[ServerEventService] dropped group "
          + (inboundKind || "message") + " from non-member "
          + (authedSender || "<unauthenticated>") + " for group " + groupId);
        return;
      }
    }

    // Registry-driven dispatch: look up the kind in PAYLOAD_KIND_REGISTRY
    // and let the entry's handler consume it. The default rez.chat.message.v1
    // entry returns `false` so the deposit flows through to the message-
    // deposited persistence path below.
    if (decodedPayload && typeof decodedPayload.kind === "string") {
      const entry = getPayloadEntry(decodedPayload.kind);
      if (entry && typeof entry.dispatch === "function") {
        // If the entry has a recordClass, construct a typed payload record
        // here at the receive boundary. Dispatch handlers downstream get a
        // validated record, not a raw plain object. If construction throws
        // (malformed wire payload), log and skip.
        let payloadForDispatch = decodedPayload;
        if (entry.recordClass) {
          try {
            payloadForDispatch = new entry.recordClass(decodedPayload);
          } catch (err) {
            this.logger.warn("[ServerEventService] dropped malformed " + decodedPayload.kind + " payload:",
              err && err.message ? err.message : err);
            return;
          }
        }
        const dispatchChannelId = decodedPayload && typeof decodedPayload.channelId === "string"
          ? decodedPayload.channelId.trim()
          : "";
        const dispatchCtx = { threadId, thread, peerAccountId: peerAcct || envelopeSender, channelId: dispatchChannelId };
        const consumed = await entry.dispatch(payloadForDispatch, dispatchCtx, this.bus.services).catch((err) => {
          this.logger.warn("[ServerEventService] payload dispatch failed for " + decodedPayload.kind,
            err && err.message ? err.message : err);
          return false;
        });
        if (consumed) return;
      } else if (!entry) {
        this.logger.warn("[ServerEventService] unknown payload kind", decodedPayload.kind);
      }
    }

    // Prefer the cryptographically-authenticated sender (peerAcct from a direct
    // thread's peer-link, or envelopeSender from the decrypted snapshot) over
    // the payload's self-declared sender, which a peer can forge. payloadSender
    // is only a last resort for non-E2EE/system deposits that carry no peer.
    const senderAccountId = peerAcct || envelopeSender || payloadSender || null;
    const messageId = decodedPayload && typeof decodedPayload.messageId === "string"
      ? decodedPayload.messageId.trim()
      : "";
    const canonicalMessageId = messageId || eventId;

    const now = this.#clock();
    let messagePersisted = false;
    if (threadId && canonicalMessageId) {
      await this.bus.stores.threadStore.upsertDepositedMessage({
        messageId: canonicalMessageId,
        threadId,
        senderKey: senderAccountId || mailboxId,
        packetB64: ciphertextB64,
        acceptedAtMs: now,
        senderAccountId,
        status: "delivered",
        text: previewText,
        payload: decodedPayload,
      }).then(() => {
        messagePersisted = true;
      }).catch((err) => {
        this.logger.error("[ServerEventService] inbound message persist failed", err && err.message ? err.message : err);
      });

      const indexRecord = await this.bus.stores.threadIndex.upsertFromMessage({
        threadId,
        messageId: canonicalMessageId,
        ts: now,
        preview: previewText || null,
      }).catch((err) => {
        this.logger.error("[ServerEventService] inbound index upsert failed", err && err.message ? err.message : err);
        this._emit("app.error", { source: "ServerEventService", message: "inbound index upsert failed", severity: "warn", err });
      });
      if (indexRecord) {
        this.bus.services.threads.emitThreadIndexUpdated(indexRecord);
      }
    }

    if (!messagePersisted) return;

    // Delivery ack: only for 1:1 chat messages (groups have ambiguous
    // "delivered" semantics — fan-out to N peers would yield N acks per
    // message). Carries the sender's local messageId (payload.messageId,
    // not the relay's eventId) so the sender can find the row in its
    // ChatThreadStore and transition sent → delivered.
    if (decodedPayload
        && decodedPayload.kind === CHAT_MESSAGE_KIND
        && thread
        && thread.threadType !== "group"
        && messageId
        && thread.peerAccountId
        && thread.peerInboxId) {
      const sdk = this.bus.runtime && this.bus.runtime.sdk ? this.bus.runtime.sdk : null;
      if (sdk && typeof sdk.sealForPeer === "function" && sdk.mesh) {
        const ackRecord = new E2eeDeliveryAckV1({
          senderAccountId: this.ownerAccountId,
          messageIds: [messageId],
        });
        sdk.sealForPeer({
          peerAccountId: thread.peerAccountId,
          plaintextBodyBytes: ackRecord.toBytes(),
          deliverInboxId: thread.peerInboxId,
        }).then((sealed) => sdk.mesh.dispatch(
          sealed.object,
          sealed.address,
        )).catch((ackErr) => {
          this.logger.error("[ServerEventService] delivery ack send failed", ackErr && ackErr.message ? ackErr.message : ackErr);
        });
      }
    }

    if (thread && thread.threadType === "group" && thread.groupId && senderAccountId) {
      // NOTE: membership is NOT (re)established here. Receiving a message must
      // never confer or restore group membership — that was a phantom-member /
      // kicked-member-resurrection hole (audit pass 5, H1). The sender was
      // already proven to be an active member by the gate above; membership is
      // established only via the authorized member.join op.
      const observedChannelId = decodedPayload && typeof decodedPayload.channelId === "string"
        ? decodedPayload.channelId.trim() : "";
      if (observedChannelId) {
        const channelsService = this.bus.services && this.bus.services.channels;
        if (channelsService && typeof channelsService.ensureFromObservedMessage === "function") {
          await channelsService.ensureFromObservedMessage({
            groupId: thread.groupId,
            channelId: observedChannelId,
            senderAccountId,
          }).catch(err => {
            this.logger.error("[ServerEventService] channel observation upsert failed",
              err && err.message ? err.message : err);
          });
        }
      }
    }

    const record = new MessageDepositedEvent({
      threadId,
      message: {
        messageId: canonicalMessageId,
        threadId,
        senderAccountId,
        text: previewText,
        payload: decodedPayload,
        status: "delivered",
        createdAtMs: now,
        acceptedAtMs: now,
        packetB64: ciphertextB64,
      },
    });
    this._emit("runtime.event.message.deposited", record);
    this._emit("message.deposited", record);
  }

  async #handleDeliveryAck(event) {
    const frame = event && typeof event === "object" ? event : {};
    const body = frame.body && typeof frame.body === "object" ? frame.body : frame;
    const threadId = typeof body.threadId === "string" ? body.threadId.trim() : "";
    const messageIds = Array.isArray(body.messageIds) ? body.messageIds : [];
    if (messageIds.length === 0) return;
    await this.bus.services.messages.handleDeliveryAck({ threadId, messageIds });
  }

  /**
   * Shape A: ServerPeerLinkProtocolService emits this bus event after
   * decrypting an inbound E2EE user message. We feed it through the same
   * mailbox-deposit pipeline used for plaintext deposits, since after
   * decrypt the shape is identical (ciphertextB64 carries plaintext).
   */
  async #handlePeerlinkUserMessage(payload) {
    const data = payload && typeof payload === "object" ? payload : {};
    if (!data.eventId || !data.plaintextB64) return;
    // The decrypted snapshot identifies the sender authoritatively — pass
    // it through as an envelope-level senderAccountId so dispatch can
    // route payloads that don't self-describe their sender (e.g.
    // GroupOpPayloadV1, ChannelOpPayloadV1) even when the receiver has
    // no prior DM thread with the sender.
    const senderAccountId = typeof data.senderAccountId === "string" ? data.senderAccountId.trim() : "";
    await this.#handleMailboxDeposited({
      body: {
        eventId: data.eventId,
        mailboxId: data.mailboxId || "",
        ciphertextB64: data.plaintextB64,
        senderAccountId,
      },
    });
  }

  // Hold a decrypted group message whose sender isn't an active member yet,
  // keyed by `groupId:accountId`, bounded by key count and per-key depth (oldest
  // evicted). Re-applied by flushDeferredGroupMessages when the join lands.
  #deferGroupMessage(groupId, accountId, event) {
    const key = groupId + ":" + accountId;
    let bucket = this.#deferredGroupMessages.get(key);
    if (!bucket) {
      if (this.#deferredGroupMessages.size >= this.#maxDeferredKeys) {
        const oldestKey = this.#deferredGroupMessages.keys().next().value;
        if (oldestKey) this.#deferredGroupMessages.delete(oldestKey);
      }
      bucket = [];
      this.#deferredGroupMessages.set(key, bucket);
    }
    if (bucket.length >= this.#maxDeferredPerKey) bucket.shift();
    bucket.push(event);
    if (process.env.REZ_PEERLINK_TRACE === "1") {
      this.logger.log("[PLTRACE] gate DEFER group=" + groupId + " sender=" + accountId + " (held=" + bucket.length + ")");
    }
  }

  /**
   * Re-apply any group messages deferred for `accountId` in `groupId`, now that
   * their member.join has activated them. Called by ServerGroupsService after an
   * inbound member.join is applied. Re-application runs through the same deposit
   * path (the message bytes are already-decrypted plaintext); the
   * #redeliveringDeferred guard ensures a message that STILL fails the gate is
   * dropped rather than re-deferred (no loop).
   */
  async flushDeferredGroupMessages(groupId, accountId) {
    const gid = typeof groupId === "string" ? groupId.trim() : "";
    const acct = typeof accountId === "string" ? accountId.trim() : "";
    if (!gid || !acct) return;
    const key = gid + ":" + acct;
    const bucket = this.#deferredGroupMessages.get(key);
    if (!bucket || bucket.length === 0) return;
    this.#deferredGroupMessages.delete(key);
    if (process.env.REZ_PEERLINK_TRACE === "1") {
      this.logger.log("[PLTRACE] gate FLUSH group=" + gid + " sender=" + acct + " (n=" + bucket.length + ")");
    }
    this.#redeliveringDeferred = true;
    try {
      for (const event of bucket) {
        try {
          await this.#handleMailboxDeposited(event);
        } catch (err) {
          this.logger.error("[ServerEventService] deferred group message re-apply failed",
            err && err.message ? err.message : err);
        }
      }
    } finally {
      this.#redeliveringDeferred = false;
    }
  }

  async #resolveDirectThreadForSender({ senderAccountId, createdAtMs } = {}) {
    const peerAccountId = typeof senderAccountId === "string" ? senderAccountId.trim() : "";
    if (!peerAccountId) return null;

    const threadStore = this.bus.stores && this.bus.stores.threadStore ? this.bus.stores.threadStore : null;
    if (threadStore && typeof threadStore.listThreadIds === "function") {
      const threadIds = await threadStore.listThreadIds().catch(() => []);
      for (const id of threadIds) {
        const threadId = typeof id === "string" ? id.trim() : "";
        if (!threadId) continue;
        const candidate = await threadStore.getThread(threadId).catch(() => null);
        if (!candidate || typeof candidate !== "object") continue;
        const type = String(candidate.threadType || candidate.kind || "direct").trim().toLowerCase();
        const candidatePeer = typeof candidate.peerAccountId === "string" ? candidate.peerAccountId.trim() : "";
        if (type === "direct" && candidatePeer === peerAccountId) {
          if (typeof candidate.peerInboxId === "string" && candidate.peerInboxId.trim()) {
            return { threadId, thread: candidate };
          }
          return this.#repairDirectThreadFromPeerLink({
            threadId,
            peerAccountId,
            createdAtMs,
          });
        }
      }
    }

    return this.#repairDirectThreadFromPeerLink({
      threadId: "",
      peerAccountId,
      createdAtMs,
    });
  }

  async #repairDirectThreadFromPeerLink({ threadId, peerAccountId, createdAtMs } = {}) {
    const peerLinksResult = await this._call("peer-links", "list", {}).catch(() => null);
    const peerLinks = peerLinksResult && Array.isArray(peerLinksResult.items) ? peerLinksResult.items : [];
    const peerLink = peerLinks.find((item) => {
      if (!item || typeof item !== "object") return false;
      const remote = typeof item.peerAccountId === "string" ? item.peerAccountId.trim() : "";
      return remote === peerAccountId;
    });
    if (!peerLink) return null;

    let resolvedThreadId = typeof threadId === "string" ? threadId.trim() : "";
    const peerLinkId = typeof peerLink.peerLinkId === "string" ? peerLink.peerLinkId.trim() : "";
    if (!resolvedThreadId && peerLinkId && this.bus.services.threads
        && typeof this.bus.services.threads.directThreadIdForPeerLink === "function") {
      resolvedThreadId = this.bus.services.threads.directThreadIdForPeerLink(peerLinkId, peerAccountId);
    }
    if (!resolvedThreadId) return null;

    const peerInboxId = peerLinkPeerInboxId(peerLink);
    const ensured = await this.bus.services.threads.ensureDirectThread({
      threadId: resolvedThreadId,
      peerAccountId,
      peerInboxId,
      createdAtMs,
    }).catch((err) => {
      this.logger.error("[ServerEventService] direct thread repair failed", err && err.message ? err.message : err);
      this._emit("app.error", { source: "ServerEventService", message: "direct thread repair failed", severity: "warn", err });
      return null;
    });
    if (!ensured) return null;
    const thread = ensured && ensured.thread && typeof ensured.thread === "object" ? ensured.thread : ensured;
    return { threadId: resolvedThreadId, thread };
  }
}

function peerLinkPeerInboxId(peerLink) {
  if (!peerLink || typeof peerLink !== "object") return null;
  const peerInboxId = typeof peerLink.peerInboxId === "string" ? peerLink.peerInboxId.trim() : "";
  return peerInboxId || null;
}
