import {
  ChatMessage,
  MessageDepositedEvent,
  MessageUpdatedEvent,
  PeerLinkUpdatedEvent,
} from "../../records/index.js";
import { getPayloadEntry } from "../../records/payloads/index.js";
import { MESSAGE_KIND as CHAT_MESSAGE_KIND } from "../../records/payloads/ChatMessagePayloadV1.js";
import { E2eeDeliveryAckV1 } from "@rezprotocol/sdk/client";
import { BaseServerService } from "../base/BaseServerService.js";
import { ServerDeferredMessageBuffer } from "./ServerDeferredMessageBuffer.js";
import { ServerGroupAuthzGate } from "./ServerGroupAuthzGate.js";

export class ServerEventService extends BaseServerService {
  #clock;
  // Decrypted group messages whose authenticated sender is not YET an active
  // member are held (not dropped) and re-applied when that member's member.join
  // lands. The buffering + bounds + redelivery guard live in
  // ServerDeferredMessageBuffer; the authz gate below consults it. See memory
  // project_offline_push_before_handshake_race.
  #deferred;
  // Fail-closed group-content authz decision (audit pass 5, H1). Resolved lazily
  // because bus.stores.groupStore is wired after services are constructed.
  #authzGate;

  constructor({ bus, ownerAccountId, clock = () => Date.now(), logger = console, maxDeferredKeys = 256, maxDeferredPerKey = 64 } = {}) {
    super({ bus, ownerAccountId, logger });
    this.#clock = clock;
    this.#deferred = new ServerDeferredMessageBuffer({
      maxKeys: maxDeferredKeys,
      maxPerKey: maxDeferredPerKey,
      logger,
    });
    this.#authzGate = null;
  }

  #groupAuthzGate() {
    if (!this.#authzGate) {
      this.#authzGate = new ServerGroupAuthzGate({
        groupStore: this.bus.stores.groupStore,
        ownerAccountId: this.ownerAccountId,
      });
    }
    return this.#authzGate;
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
    const activeInviteId = typeof body.activeInviteId === "string" ? body.activeInviteId : "";

    // Peer-link snapshots are pure crypto plumbing — they materialize the
    // direct-thread record, contact, and trigger the profile send. Group
    // membership is established by the explicit `member.join` op handled
    // by ServerGroupsService; do NOT touch group state here.
    if (body.state === "established" || body.state === "session_established") {
      // STRICT contacts/groups separation. A link establishes INVISIBLY (no DM
      // thread, no conversation-list row, no contact, no profile exchange) unless
      // it represents an explicit 1:1 relationship. Joining a big group
      // establishes a transport link per member; none may surface, or the
      // conversation list is spammed. We materialize ONLY when we already hold a
      // contact record (an `invited` connect-request placeholder, or an active
      // contact) OR the link was opened by a real DIRECT invite. Group invites
      // and the auto co-member mesh-bootstrap match neither, so they stay
      // invisible — the peer connects explicitly via connect-request.
      if (peerAccountId && !(await this.#shouldMaterializeDirectLink(peerAccountId, activeInviteId))) {
        return;
      }
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
        // We only reach here for a materializing link (gated above), so create/
        // activate the contact directly.
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
      // Direct-content delivery gate (the 1:1 analog of the group authz gate
      // below): only an APPROVED (active) contact may open/deliver into a direct
      // thread. Co-members share a transport peer-link for group fan-out, but a
      // 1:1 DM requires connect-request approval — otherwise any co-member could
      // DM a thread into existence and spam the conversation list. Keyed to the
      // cryptographically-authenticated envelopeSender (not the self-declared
      // payloadSender) so impersonation can't pass the gate. Threadless control
      // payloads (connect-request) carry no payload senderAccountId, so they
      // never enter this branch; they dispatch below via envelopeSender.
      const authedDirectSender = envelopeSender || payloadSender;
      let senderAllowed = this.bus.services.contacts
        && typeof this.bus.services.contacts.isActiveContact === "function"
        ? await this.bus.services.contacts.isActiveContact(authedDirectSender)
        : true;
      // A peer we sent a connect-request to has now ACCEPTED it: this very
      // content, authenticated and decrypted over the established link, is the
      // acceptance proof. The inviter-side snapshot gate can't catch this when we
      // were already co-members (the link is reused, so the snapshot carries the
      // co-member invite id, not our direct one), so the contact is still stuck
      // `invited` here. Activate it and let the message through instead of
      // dropping it — see ServerContactsService.acceptOutgoingConnectRequest.
      if (!senderAllowed && this.bus.services.contacts
          && typeof this.bus.services.contacts.acceptOutgoingConnectRequest === "function") {
        senderAllowed = await this.bus.services.contacts.acceptOutgoingConnectRequest(authedDirectSender);
      }
      if (senderAllowed) {
        const resolved = await this.#resolveDirectThreadForSender({
          senderAccountId: payloadSender,
          createdAtMs: this.#clock(),
        });
        if (resolved && resolved.threadId && resolved.thread) {
          threadId = resolved.threadId;
          thread = resolved.thread;
        }
      } else {
        this.logger.warn("[ServerEventService] dropped direct content from non-contact " + authedDirectSender);
      }
    }
    const peerAcct = thread && typeof thread.peerAccountId === "string" ? thread.peerAccountId.trim() : "";

    // SECURITY (REZ-3) — direct-thread sender binding. For a 1:1 thread the
    // message MUST come from that thread's peer. `threadId` is attacker-supplied;
    // the direct-content gate above (isActiveContact) only runs when the thread had
    // to be RESOLVED from the sender (the `!thread` branch). When the attacker
    // supplies an existing direct threadId that resolved a thread, that gate is
    // skipped and the group gate below ignores non-group threads — so without this
    // check a co-member who can deliver an authenticated payload could pass any
    // direct threadId and have their message attributed to (and edit/tombstone/
    // react AS) the thread's real peer. envelopeSender is cryptographically
    // authenticated; drop when it doesn't own the resolved direct thread.
    if (thread && thread.threadType === "direct" && envelopeSender && peerAcct && peerAcct !== envelopeSender) {
      this.logger.warn("[ServerEventService] dropped direct content: thread peer "
        + peerAcct + " != authenticated sender " + envelopeSender);
      return;
    }

    // SECURITY — authoritative group-content authorization (audit pass 5, H1).
    // The decision lives in ServerGroupAuthzGate; we own the side effects. The
    // only trustworthy sender identity is `envelopeSender` (the cryptographically
    // authenticated account from the decrypted peer-link snapshot). A "defer"
    // verdict holds a brand-new sender's message until their member.join lands
    // (does NOT weaken the gate); a "drop" fails closed.
    const inboundKind = decodedPayload && typeof decodedPayload.kind === "string" ? decodedPayload.kind : "";
    const authedSender = envelopeSender;
    const verdict = await this.#groupAuthzGate().evaluate({
      thread,
      inboundKind,
      authedSender,
      redelivering: this.#deferred.redelivering,
    });
    if (verdict.action === "defer") {
      this.#deferred.defer(verdict.groupId, authedSender, event);
      return;
    }
    if (verdict.action === "drop") {
      this.logger.warn("[ServerEventService] dropped group "
        + (inboundKind || "message") + " from non-member "
        + (authedSender || "<unauthenticated>") + " for group " + verdict.groupId);
      return;
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
    let persistedMutated = null;
    if (threadId && canonicalMessageId) {
      const persistResult = await this.bus.stores.threadStore.upsertDepositedMessage({
        messageId: canonicalMessageId,
        threadId,
        senderKey: senderAccountId || mailboxId,
        packetB64: ciphertextB64,
        acceptedAtMs: now,
        senderAccountId,
        status: "delivered",
        text: previewText,
        payload: decodedPayload,
      }).catch((err) => {
        this.logger.error("[ServerEventService] inbound message persist failed", err && err.message ? err.message : err);
        return null;
      });
      if (persistResult) {
        messagePersisted = true;
        // Out-of-order mutations (edit/reaction/tombstone delivered before their
        // target) were buffered and folded in on deposit. The message.deposited
        // event below carries the BASE message, so capture the mutated row and
        // emit message.updated after it — otherwise the fold is invisible until
        // a refetch.
        if (persistResult.mutated && persistResult.message) {
          persistedMutated = persistResult.message;
        }
      }

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

    // Follow the base deposit with the folded-in state when buffered mutations
    // drained on arrival, so the renderer applies the edit/reaction/tombstone
    // instead of showing the un-mutated message until the next refetch.
    if (persistedMutated) {
      const mutatedMessage = persistedMutated instanceof ChatMessage
        ? persistedMutated
        : new ChatMessage({ ...persistedMutated, threadId });
      this._emit("message.updated", new MessageUpdatedEvent({ threadId, message: mutatedMessage }));
    }
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

  /**
   * Re-apply any group messages deferred for `accountId` in `groupId`, now that
   * their member.join has activated them. Called by ServerGroupsService after an
   * inbound member.join is applied. Delegates to ServerDeferredMessageBuffer,
   * which re-runs each held event through the same deposit path
   * (#handleMailboxDeposited) under its redelivery guard so a message that STILL
   * fails the gate is dropped rather than re-deferred (no loop).
   */
  async flushDeferredGroupMessages(groupId, accountId) {
    await this.#deferred.flush(groupId, accountId, (event) => this.#handleMailboxDeposited(event));
  }

  // STRICT contacts/groups separation gate for the peer-link-established path.
  // This path materializes the INVITER/REQUESTER side (the acceptor materializes
  // its own thread synchronously inside ServerInvitesService.acceptInvite). A
  // direct thread + conversation-list row appears ONLY when:
  //   (a) the contact is already ACTIVE — re-establishment/recovery of a link we
  //       have already accepted, or
  //   (b) the link was opened by a real DIRECT invite we minted (the out-of-band
  //       "Generate invite code" flow, or a connect-request whose peer just
  //       ACCEPTED — the snapshot's activeInviteId is that direct invite).
  // Deliberately NOT keyed on a mere contact RECORD: an outgoing connect-request
  // leaves an `invited` placeholder for pending UI, but the peer has not accepted
  // yet — its only snapshots are co-member/heartbeat/recovery links carrying a
  // DIFFERENT invite id, so they fall through here and no premature DM thread is
  // shown. A group invite (membership only) and the auto co-member mesh-bootstrap
  // also match neither, so they establish invisibly. Fail closed (invisible).
  async #shouldMaterializeDirectLink(peerAccountId, activeInviteId) {
    const contacts = this.bus.services && this.bus.services.contacts ? this.bus.services.contacts : null;
    if (contacts && typeof contacts.isActiveContact === "function"
        && await contacts.isActiveContact(peerAccountId)) {
      return true;
    }
    const invites = this.bus.services && this.bus.services.invites ? this.bus.services.invites : null;
    if (activeInviteId && invites && typeof invites.isDirectContactInvite === "function"
        && invites.isDirectContactInvite(activeInviteId)) {
      return true;
    }
    return false;
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
