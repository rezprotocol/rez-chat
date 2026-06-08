import { base64ToBytes, buildInboxAddress, bytesToBase64 } from "@rezprotocol/sdk/client";
import { BaseServerService } from "../base/BaseServerService.js";

/**
 * ServerPeerLinkProtocolService — chat-server-side handler for peer-link
 * protocol messages flowing over mailbox deposits (Shape A).
 *
 * Subscribes to `sdk.subscriptions.onMailboxDeposited`. Each deposit body is
 * parsed and routed by kind:
 *
 *   - Plaintext JSON:
 *     - `rez.peerlink.handshake.ack` — handleIncomingHandshakeAck.
 *
 *   - E2EE packets:
 *     - `x3dh.handshake.v2` with `rehandshakeRequestId` — handleRehandshakeResponse.
 *     - `x3dh.handshake.v2` (regular) — handleIncomingHandshakePacket; on
 *       success, send a handshake.ack to the acceptor's inbox. The SDK
 *       handler verifies the envelope signature and derives senderAccountId
 *       from the signed pubkey — this service never trusts plaintext
 *       senderAccountId on the wire.
 *     - `x3dh.rehandshake.v1` — handleIncomingRehandshake; send the response
 *       handshake bytes back to the requester's inbox.
 *     - regular E2EE deposit — decrypt via PeerLinkService; if inner is a
 *       `rez.delivery.ack` emit `delivery.ack` on the chat bus; otherwise
 *       emit `peerlink.user.message` carrying plaintext for ServerEventService.
 */
export class ServerPeerLinkProtocolService extends BaseServerService {
  #clock;

  constructor({ bus, ownerAccountId, clock = () => Date.now(), logger = console } = {}) {
    super({ bus, ownerAccountId, logger });
    this.#clock = clock;
  }

  async start() {
    // Inbound deposit decryption is a directive, not an event: the
    // InboundDepositPipeline calls processDeposit() directly and awaits it,
    // one deposit at a time in order, so a handshake/member.join is fully
    // applied before any dependent message is evaluated. No bus subscription
    // here. See memory feedback_inbound_deposit_pipeline_must_be_awaited_calls.
  }

  /**
   * Decrypt + handle one inbound mailbox deposit. Protocol bodies (handshake,
   * ack, reject, rehandshake, delivery-ack) are applied in place and resolve
   * to `null`. A decrypted E2EE *user* message is RETURNED as
   * `{ userMessage }` for the pipeline to apply via
   * ServerEventService.applyUserMessage — never emitted, so the apply is
   * awaited in deposit order. Awaitable directive.
   *
   * @returns {Promise<null | { userMessage: object }>}
   */
  async processDeposit(event) {
    const tr = process.env.REZ_PEERLINK_TRACE === "1";
    const frame = event && typeof event === "object" ? event : {};
    const body = frame.body && typeof frame.body === "object" ? frame.body : frame;
    const ciphertextB64 = typeof body.ciphertextB64 === "string" ? body.ciphertextB64 : "";
    const mailboxId = typeof body.mailboxId === "string" ? body.mailboxId : "";
    const eventId = typeof body.eventId === "string" ? body.eventId : "";
    if (!ciphertextB64) {
      if (tr) this.logger.log("[PLTRACE] processDeposit SKIP no-ciphertextB64 mbox=" + mailboxId + " evt=" + eventId);
      return { consumed: false, decryptOk: false, reason: "no-ciphertext" };
    }

    let payloadBytes;
    try {
      payloadBytes = base64ToBytes(ciphertextB64);
    } catch (b64Err) {
      if (tr) this.logger.log("[PLTRACE] processDeposit SKIP base64-fail evt=" + eventId + " err=" + (b64Err && b64Err.message ? b64Err.message : b64Err));
      return { consumed: false, decryptOk: false, reason: "base64-fail" };
    }

    let bodyObj = null;
    let parseErr = null;
    try {
      const text = new TextDecoder().decode(payloadBytes);
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        bodyObj = parsed;
      }
    } catch (err) {
      parseErr = err;
      bodyObj = null;
    }
    if (!bodyObj) {
      if (tr) {
        const head = Buffer.from(payloadBytes.slice(0, 24)).toString("hex");
        this.logger.log("[PLTRACE] processDeposit SKIP unparseable evt=" + eventId + " bytes=" + payloadBytes.length + " head=" + head + (parseErr ? " err=" + (parseErr.message || parseErr) : ""));
      }
      return { consumed: false, decryptOk: false, reason: "unparseable" };
    }

    // Receive-path trace (opt-in via REZ_PEERLINK_TRACE): classify every inbound
    // deposit so a captured run.log shows exactly which establishment/decrypt path
    // each packet took — the single highest-signal line for diagnosing one-sided
    // peer links (handshake never processed) vs ratchet desync.
    if (process.env.REZ_PEERLINK_TRACE === "1") {
      this.logger.log(
        "[PLTRACE] deposit owner=" + this.ownerAccountId + " mbox=" + mailboxId + " evt=" + eventId
        + " type=" + (typeof bodyObj.type === "string" ? bodyObj.type : "-")
        + " kind=" + (typeof bodyObj.kind === "string" ? bodyObj.kind : "-")
        + " e2ee=" + (bodyObj.e2ee === 1 ? "1" : "0")
        + " hs=" + (bodyObj.handshake ? "1" : "0")
        + (bodyObj.handshake && bodyObj.handshake.rehandshakeRequestId ? " rehsResp=1" : "")
        + " bytes=" + payloadBytes.length,
      );
    }

    // --- Plaintext peer-link protocol messages ---

    const peerLinks = this._peerLinkService();
    if (!peerLinks) return;

    // Introduction response — MUST be checked BEFORE both the rehandshake
    // response and the regular handshake, since all three match
    // e2ee:1 + type=x3dh.handshake.v2. Routed on the presence of
    // `introductionId`; the SDK verifies the envelope + binding (no plaintext
    // trust). This is the response to a co-member introduction WE initiated.
    if (bodyObj.e2ee === 1
        && bodyObj.type === "x3dh.handshake.v2"
        && bodyObj.handshake
        && typeof bodyObj.handshake === "object"
        && bodyObj.handshake.introductionId) {
      if (typeof peerLinks.handleIntroductionResponse !== "function") return;
      let result;
      try {
        result = await peerLinks.handleIntroductionResponse({
          ownerAccountId: this.ownerAccountId,
          packetBytes: payloadBytes,
        });
      } catch (introErr) {
        this.logger.error("[ServerPeerLinkProtocolService] introduction response failed", introErr && introErr.message ? introErr.message : introErr);
        return;
      }
      if (!result) return { consumed: false, decryptOk: false, reason: "introduction-response-noop" };
      this._emitPeerLinkUpdated(result.snapshot);
      return { consumed: true, decryptOk: true };
    }

    // Re-handshake response — MUST be checked BEFORE the regular handshake
    // since both match e2ee:1 + type=x3dh.handshake.v2.
    //
    // We route on the presence of `rehandshakeRequestId` in the unverified
    // payload, but only the SDK is allowed to trust handshake contents — it
    // verifies the envelope signature and derives accountId from the verified
    // pubkey + accountBinding chain. Plaintext senderAccountId is no longer
    // accepted here.
    if (bodyObj.e2ee === 1
        && bodyObj.type === "x3dh.handshake.v2"
        && bodyObj.handshake
        && typeof bodyObj.handshake === "object"
        && bodyObj.handshake.rehandshakeRequestId) {
      if (typeof peerLinks.handleRehandshakeResponse !== "function") return;
      let result;
      try {
        result = await peerLinks.handleRehandshakeResponse({
          ownerAccountId: this.ownerAccountId,
          packetBytes: payloadBytes,
        });
      } catch (rhErr) {
        this.logger.error("[ServerPeerLinkProtocolService] rehandshake response failed", rhErr && rhErr.message ? rhErr.message : rhErr);
        return;
      }
      if (!result) return { consumed: false, decryptOk: false, reason: "rehs-response-noop" };
      this._emitPeerLinkUpdated(result.snapshot);
      return { consumed: true, decryptOk: true };
    }

    // Regular peer-link handshake.
    if (bodyObj.e2ee === 1
        && bodyObj.type === "x3dh.handshake.v2"
        && bodyObj.handshake
        && typeof bodyObj.handshake === "object") {
      if (typeof peerLinks.handleIncomingHandshakePacket !== "function") return;
      let handled;
      try {
        handled = await peerLinks.handleIncomingHandshakePacket({
          ownerAccountId: this.ownerAccountId,
          packetBytes: payloadBytes,
        });
      } catch (hsErr) {
        this.logger.error("[ServerPeerLinkProtocolService] handshake processing failed", hsErr && hsErr.message ? hsErr.message : hsErr);
        return;
      }
      if (!handled) return { consumed: false, decryptOk: false, reason: "handshake-not-handled" };
      // Lazy maxUses enforcement declined this handshake (invite used up or
      // expired). No session was established and the inviter holds no
      // peer-link for it — deposit a signed reject so the acceptor can roll
      // back its optimistic peer-link. The handshake itself IS consumed (we
      // decided on it), so it must be acked, not retried.
      if (handled.rejected) {
        const rejectInboxId = String(handled.acceptorInboxId || "").trim();
        if (rejectInboxId) {
          await this._sendHandshakeReject({
            deliverInboxId: rejectInboxId,
            reason: handled.reason || "INVITE_REJECTED",
            ackNonce: handled.ackNonce || null,
          });
        }
        return { consumed: true, decryptOk: true };
      }
      this._emitPeerLinkUpdated(handled.snapshot, handled.remoteDisplayName);
      const acceptorInboxId = handled.snapshot
        ? String(handled.snapshot.peerInboxId || "").trim()
        : "";
      if (acceptorInboxId) {
        await this._sendHandshakeAck({
          deliverInboxId: acceptorInboxId,
          ownerDisplayName: handled.localDisplayName || "",
          ackNonce: handled.ackNonce || null,
        });
      }
      return { consumed: true, decryptOk: true };
    }

    // Re-handshake request.
    if (bodyObj.e2ee === 1
        && bodyObj.type === "x3dh.rehandshake.v1"
        && bodyObj.rehandshake
        && typeof bodyObj.rehandshake === "object") {
      if (typeof peerLinks.handleIncomingRehandshake !== "function") return;
      const rh = bodyObj.rehandshake;
      let result;
      try {
        result = await peerLinks.handleIncomingRehandshake({
          ownerAccountId: this.ownerAccountId,
          requestId: rh.requestId,
          senderAccountId: rh.senderAccountId,
          senderInboxId: rh.senderInboxId,
          bundleJson: rh.bundleJson,
        });
      } catch (rhErr) {
        this.logger.error("[ServerPeerLinkProtocolService] rehandshake processing failed", rhErr && rhErr.message ? rhErr.message : rhErr);
        return;
      }
      if (!result) return { consumed: false, decryptOk: false, reason: "rehs-request-noop" };
      this._emitPeerLinkUpdated(result.snapshot);
      if (result.handshakePacket && result.deliverInboxId) {
        try {
          await this._sdk().mesh.dispatch(
            {
              payloadBytes: result.handshakePacket.toBytes(),
              objectId: "rhresp_" + Date.now() + "_" + Math.random().toString(36).slice(2, 10),
              metadata: {},
            },
            buildInboxAddress({ inboxId: result.deliverInboxId }),
          );
        } catch (sendErr) {
          this.logger.error("[ServerPeerLinkProtocolService] rehandshake response send failed", sendErr && sendErr.message ? sendErr.message : sendErr);
        }
      }
      return { consumed: true, decryptOk: true };
    }

    // Introduction request (co-member mesh bootstrap). Structurally a
    // rehandshake request, but authorized by CO-MEMBERSHIP rather than an
    // existing link: the sender must be an active member of a group we are also
    // in. Like rehandshake it rides UNSEALED to our inbox (no shared ratchet
    // yet); authenticity is the signed account binding the SDK verifies.
    if (bodyObj.e2ee === 1
        && bodyObj.type === "x3dh.introduce.v1"
        && bodyObj.introduction
        && typeof bodyObj.introduction === "object") {
      if (typeof peerLinks.handleIncomingIntroduction !== "function") return;
      const intro = bodyObj.introduction;
      const introSender = typeof intro.senderAccountId === "string" ? intro.senderAccountId.trim() : "";
      // Co-membership gate. If we don't yet know the sender as a co-member, the
      // member.contact op announcing them may simply not have arrived yet
      // (same ordering race as push-before-member.join). Leave the deposit
      // BUFFERED (not consumed) so a later drain — after member.contact applies
      // — retries it, rather than dropping a legitimate introduction.
      const coMember = await this._isCoMember(introSender);
      if (!coMember) {
        return { consumed: false, decryptOk: false, reason: "introduction-not-co-member" };
      }
      const sdk = this._sdk();
      const ownerInboxId = sdk ? this._ownInboxId(sdk) : "";
      let result;
      try {
        result = await peerLinks.handleIncomingIntroduction({
          ownerAccountId: this.ownerAccountId,
          ownerInboxId: ownerInboxId || null,
          introductionId: intro.introductionId,
          senderAccountId: intro.senderAccountId,
          senderInboxId: intro.senderInboxId,
          bundleJson: intro.bundleJson,
        });
      } catch (introErr) {
        this.logger.error("[ServerPeerLinkProtocolService] introduction processing failed", introErr && introErr.message ? introErr.message : introErr);
        return;
      }
      // null = idempotent no-op (already established). The introduction itself is
      // handled either way, so it is consumed.
      if (!result) return { consumed: true, decryptOk: true };
      this._emitPeerLinkUpdated(result.snapshot);
      if (result.handshakePacket && result.deliverInboxId && sdk && sdk.mesh) {
        try {
          await sdk.mesh.dispatch(
            {
              payloadBytes: result.handshakePacket.toBytes(),
              objectId: "introresp_" + Date.now() + "_" + Math.random().toString(36).slice(2, 10),
              metadata: {},
            },
            buildInboxAddress({ inboxId: result.deliverInboxId }),
          );
        } catch (sendErr) {
          this.logger.error("[ServerPeerLinkProtocolService] introduction response send failed", sendErr && sendErr.message ? sendErr.message : sendErr);
        }
      }
      return { consumed: true, decryptOk: true };
    }

    // Handshake ack (signed envelope from inviter → acceptor). MED-1: the
    // ack must be authenticated by the inviter's X3DH identity signing key;
    // see rez-sdk/src/peer-link/PeerLinkService.js handleIncomingHandshakeAck.
    if (bodyObj.kind === "rez.peerlink.handshake.ack.v2") {
      if (typeof peerLinks.handleIncomingHandshakeAck !== "function") return;
      let handled;
      try {
        handled = await peerLinks.handleIncomingHandshakeAck({
          ownerAccountId: this.ownerAccountId,
          ackPacketBytes: payloadBytes,
        });
      } catch (ackErr) {
        this.logger.error("[ServerPeerLinkProtocolService] handshake.ack processing failed", ackErr && ackErr.message ? ackErr.message : ackErr);
        return;
      }
      if (!handled) return { consumed: false, decryptOk: false, reason: "ack-not-handled" };
      this._emitPeerLinkUpdated(handled.snapshot, handled.remoteDisplayName);
      return { consumed: true, decryptOk: false };
    }

    // Handshake reject (signed envelope from inviter → acceptor). Authenticated
    // the same way as the ack; rolls back the acceptor's optimistic peer-link
    // when the inviter's lazy maxUses check declined the handshake.
    if (bodyObj.kind === "rez.peerlink.handshake.reject.v1") {
      if (typeof peerLinks.handleHandshakeReject !== "function") return;
      let handled;
      try {
        handled = await peerLinks.handleHandshakeReject({
          ownerAccountId: this.ownerAccountId,
          rejectPacketBytes: payloadBytes,
        });
      } catch (rejErr) {
        this.logger.error("[ServerPeerLinkProtocolService] handshake.reject processing failed", rejErr && rejErr.message ? rejErr.message : rejErr);
        return;
      }
      if (!handled) return { consumed: false, decryptOk: false, reason: "reject-not-handled" };
      this._emitPeerLinkUpdated(handled.snapshot);
      return { consumed: true, decryptOk: false };
    }

    // E2EE direct message (user content or delivery ack inside ciphertext).
    if (bodyObj.e2ee === 1 && typeof bodyObj.v === "number" && typeof bodyObj.payload === "string") {
      if (typeof peerLinks.decryptDirectMessageAnyPeer !== "function") return;
      let decResult;
      try {
        decResult = await peerLinks.decryptDirectMessageAnyPeer({
          ownerAccountId: this.ownerAccountId,
          packetBytes: payloadBytes,
        });
      } catch (decErr) {
        this.logger.error("[ServerPeerLinkProtocolService] E2EE decryption failed", decErr && decErr.message ? decErr.message : decErr);
        const isThreadNotReady = Boolean(decErr && decErr.code === "THREAD_NOT_READY");
        // decryptDirectMessageAnyPeer (the only decrypt on this path) reports a
        // total miss as THREAD_NOT_READY with state-attributed recoveryCandidates;
        // it never throws the single-peer DECRYPT_FAILED. Recipient-side recovery:
        // a packet we could not decrypt against ANY usable session may mean a
        // desynced/one-sided peer link. The opaque packet cannot identify its
        // sender, so only act when EXACTLY ONE candidate link has crossed the
        // rehandshake threshold — zero or ambiguous (>1) candidates are left to
        // retry, never guessed. The in-flight rehandshake_requested state is a
        // natural cooldown.
        if (isThreadNotReady && Array.isArray(decErr.recoveryCandidates)) {
          const eligible = decErr.recoveryCandidates.filter((c) => c && c.rehandshakeNeeded === true);
          if (eligible.length === 1) {
            this._triggerRehandshake({ peerAccountId: eligible[0].peerAccountId });
          }
        }
        // NOT consumed — leave the deposit buffered. The decrypt did not advance
        // the ratchet, so a later drain (once the establishing handshake ahead of
        // it is applied, or a rehandshake lands) can decrypt it. Acking here would
        // destroy a message we simply can't read YET (the desktop data-loss bug).
        return { consumed: false, decryptOk: false, reason: isThreadNotReady ? "thread-not-ready" : "decrypt-failed" };
      }
      if (!decResult || !(decResult.plaintextBytes instanceof Uint8Array)) {
        return { consumed: false, decryptOk: false, reason: "decrypt-empty" };
      }

      // Emit the snapshot-updated event only when an actual peer-link state
      // transition occurred (decResult.event is non-null). Snapshot is now
      // populated on every decrypt for downstream sender resolution, so we
      // can't use its presence to detect transitions; the event record is
      // the authoritative transition signal.
      if (decResult.event && decResult.snapshot) {
        this._emitPeerLinkUpdated(decResult.snapshot);
      }

      try {
        const innerText = new TextDecoder().decode(decResult.plaintextBytes);
        const inner = JSON.parse(innerText);
        if (inner && inner.kind === "rez.delivery.ack"
            && typeof inner.senderAccountId === "string"
            && Array.isArray(inner.messageIds)) {
          this._emit("delivery.ack", {
            senderAccountId: inner.senderAccountId,
            messageIds: inner.messageIds,
          });
          return { consumed: true, decryptOk: true };
        }
      } catch {
        // not JSON or not a protocol message — fall through as user message
      }

      // Non-ack payload: surface it for the chat layer to dispatch + persist.
      // Acks are emitted from the chat layer (ServerEventService) where the
      // payload kind and sender's messageId are known — only real chat
      // messages should trigger a delivery ack, and the ack must carry the
      // sender's local messageId (not the relay eventId).
      const snapshot = decResult.snapshot;
      const decryptedSender = snapshot && typeof snapshot.peerAccountId === "string"
        ? snapshot.peerAccountId.trim() : "";
      // Return the decrypted user message for the pipeline to apply (awaited,
      // in deposit order) — NOT an emit. A fire-and-forget emit here let a
      // group message race ahead of the sender's member.join and get dropped
      // by the membership gate. See memory
      // feedback_inbound_deposit_pipeline_must_be_awaited_calls.
      return {
        consumed: true,
        decryptOk: true,
        userMessage: {
          mailboxId,
          eventId,
          plaintextB64: bytesToBase64(decResult.plaintextBytes),
          senderAccountId: decryptedSender || null,
          snapshot: snapshot || null,
        },
      };
    }
    return { consumed: false, decryptOk: false, reason: "unknown-type" };
  }

  async _sendHandshakeAck({ deliverInboxId, ownerDisplayName = "", ackNonce = null }) {
    const sdk = this._sdk();
    if (!sdk || !sdk.mesh) return;
    if (typeof ackNonce !== "string" || ackNonce.length === 0) {
      this.logger.warn("[ServerPeerLinkProtocolService] handshake.ack send skipped — missing ackNonce");
      return;
    }
    const peerLinks = this._peerLinkService();
    if (!peerLinks || typeof peerLinks.createSignedHandshakeAck !== "function") {
      this.logger.warn("[ServerPeerLinkProtocolService] handshake.ack send skipped — SDK missing createSignedHandshakeAck");
      return;
    }
    const senderInboxId = this._ownInboxId(sdk);
    let ackBytes;
    try {
      const result = await peerLinks.createSignedHandshakeAck({
        ownerAccountId: this.ownerAccountId,
        ownerInboxId: senderInboxId || null,
        ownerDisplayName: typeof ownerDisplayName === "string" ? ownerDisplayName : "",
        ackNonce,
      });
      ackBytes = result.ackBytes;
    } catch (signErr) {
      this.logger.error("[ServerPeerLinkProtocolService] handshake.ack sign failed", signErr && signErr.message ? signErr.message : signErr);
      return;
    }
    try {
      await sdk.mesh.dispatch(
        {
          payloadBytes: ackBytes,
          objectId: "hsack_" + Date.now() + "_" + Math.random().toString(36).slice(2, 10),
          metadata: {},
        },
        buildInboxAddress({ inboxId: deliverInboxId }),
      );
    } catch (sendErr) {
      this.logger.error("[ServerPeerLinkProtocolService] handshake.ack send failed", sendErr && sendErr.message ? sendErr.message : sendErr);
    }
  }

  async _sendHandshakeReject({ deliverInboxId, reason, ackNonce = null }) {
    const sdk = this._sdk();
    if (!sdk || !sdk.mesh) return;
    if (typeof ackNonce !== "string" || ackNonce.length === 0) {
      this.logger.warn("[ServerPeerLinkProtocolService] handshake.reject send skipped — missing ackNonce");
      return;
    }
    const peerLinks = this._peerLinkService();
    if (!peerLinks || typeof peerLinks.createSignedHandshakeReject !== "function") {
      this.logger.warn("[ServerPeerLinkProtocolService] handshake.reject send skipped — SDK missing createSignedHandshakeReject");
      return;
    }
    let rejectBytes;
    try {
      const result = await peerLinks.createSignedHandshakeReject({
        ownerAccountId: this.ownerAccountId,
        reason: typeof reason === "string" && reason.length > 0 ? reason : "INVITE_REJECTED",
        ackNonce,
      });
      rejectBytes = result.rejectBytes;
    } catch (signErr) {
      this.logger.error("[ServerPeerLinkProtocolService] handshake.reject sign failed", signErr && signErr.message ? signErr.message : signErr);
      return;
    }
    try {
      await sdk.mesh.dispatch(
        {
          payloadBytes: rejectBytes,
          objectId: "hsrej_" + Date.now() + "_" + Math.random().toString(36).slice(2, 10),
          metadata: {},
        },
        buildInboxAddress({ inboxId: deliverInboxId }),
      );
    } catch (sendErr) {
      this.logger.error("[ServerPeerLinkProtocolService] handshake.reject send failed", sendErr && sendErr.message ? sendErr.message : sendErr);
    }
  }

  // Initiate a re-handshake with a desynced peer. The SDK builds + signs the
  // request record AND advances the local peer-link to rehandshake_requested;
  // THIS service owns transport, so it resolves the peer's inbox and dispatches
  // the request. The request rides plaintext to the peer's inbox — the ratchet
  // is desynced, so it cannot be E2EE-wrapped; authenticity is carried by the
  // signed account binding inside the bundle, which the receiver verifies in
  // handleIncomingRehandshake. Fire-and-forget: failures are logged, never
  // thrown into the deposit pipeline. (Before v0.4.6 this called the SDK with a
  // `sendRehandshake` callback + no senderInboxId — a contract mismatch that
  // made requestRehandshake throw `senderInboxId is required` and silently
  // no-op'd all recovery. See project_offline_push_before_handshake_race.)
  _triggerRehandshake({ peerAccountId }) {
    const remote = typeof peerAccountId === "string" ? peerAccountId.trim() : "";
    if (!remote) return;
    const peerLinks = this._peerLinkService();
    if (!peerLinks || typeof peerLinks.requestRehandshake !== "function") return;
    const sdk = this._sdk();
    if (!sdk || !sdk.mesh) {
      this.logger.warn("[ServerPeerLinkProtocolService] rehandshake skipped — sdk.mesh unavailable");
      return;
    }
    const senderInboxId = this._ownInboxId(sdk);
    if (!senderInboxId) {
      this.logger.warn("[ServerPeerLinkProtocolService] rehandshake skipped — no local inbox id");
      return;
    }
    this._sendRehandshakeRequest({ peerLinks, sdk, remote, senderInboxId }).catch((rhErr) => {
      this.logger.error("[ServerPeerLinkProtocolService] rehandshake request failed", rhErr && rhErr.message ? rhErr.message : rhErr);
    });
  }

  // Resolve the peer's inbox, ask the SDK to build the signed re-handshake
  // request (which also advances the local peer-link state), then dispatch the
  // request bytes to the peer. Split out from _triggerRehandshake so the latter
  // stays a synchronous fire-and-forget entry point.
  async _sendRehandshakeRequest({ peerLinks, sdk, remote, senderInboxId }) {
    const deliverInboxId = await this._resolvePeerInboxId(peerLinks, remote);
    if (!deliverInboxId) {
      this.logger.warn("[ServerPeerLinkProtocolService] rehandshake skipped — no inbox for peer " + remote);
      return;
    }
    const result = await peerLinks.requestRehandshake({
      ownerAccountId: this.ownerAccountId,
      peerAccountId: remote,
      senderInboxId,
    });
    const record = result ? result.rehandshakeRecord : null;
    if (!record || typeof record.toBytes !== "function") {
      this.logger.warn("[ServerPeerLinkProtocolService] rehandshake produced no request record for peer " + remote);
      return;
    }
    if (result.snapshot) this._emitPeerLinkUpdated(result.snapshot);
    await sdk.mesh.dispatch(
      {
        payloadBytes: record.toBytes(),
        objectId: "rhreq_" + Date.now() + "_" + Math.random().toString(36).slice(2, 10),
        metadata: {},
      },
      buildInboxAddress({ inboxId: deliverInboxId }),
    );
  }

  // Look up the peer's current delivery inbox from the peer-link snapshot list
  // (single source of truth for peer routing). Returns "" when unknown.
  async _resolvePeerInboxId(peerLinks, peerAccountId) {
    if (typeof peerLinks.listPeerLinks !== "function") return "";
    const result = await peerLinks.listPeerLinks({ ownerAccountId: this.ownerAccountId });
    const items = result && Array.isArray(result.items) ? result.items : [];
    const match = items.find((it) => it && typeof it.peerAccountId === "string" && it.peerAccountId === peerAccountId);
    return match && typeof match.peerInboxId === "string" ? match.peerInboxId.trim() : "";
  }

  // Initiate a peer-link INTRODUCTION with a co-member we have no link to.
  // Fire-and-forget (failures logged, never thrown into the op applier /
  // reconcile). Triple-gated to avoid storms and handshake glare:
  //   1. deterministic initiator — only the lexicographically-smaller accountId
  //      reaches out; the other side waits for our introduce and responds.
  //   2. skip if a live-or-pending link already exists.
  //   3. requires the peer's inbox (from the member.contact op) and our own.
  triggerIntroduction({ peerAccountId, peerInboxId } = {}) {
    const remote = typeof peerAccountId === "string" ? peerAccountId.trim() : "";
    const remoteInbox = typeof peerInboxId === "string" ? peerInboxId.trim() : "";
    if (!remote || remote === this.ownerAccountId) return;
    if (!remoteInbox) return;
    // Deterministic initiator: the smaller accountId initiates, the other waits.
    if (!(this.ownerAccountId < remote)) return;
    const peerLinks = this._peerLinkService();
    if (!peerLinks || typeof peerLinks.requestPeerLinkIntroduction !== "function") return;
    const sdk = this._sdk();
    if (!sdk || !sdk.mesh) {
      this.logger.warn("[ServerPeerLinkProtocolService] introduction skipped — sdk.mesh unavailable");
      return;
    }
    const senderInboxId = this._ownInboxId(sdk);
    if (!senderInboxId) {
      this.logger.warn("[ServerPeerLinkProtocolService] introduction skipped — no local inbox id");
      return;
    }
    this._sendIntroductionRequest({ peerLinks, sdk, remote, remoteInbox, senderInboxId }).catch((err) => {
      this.logger.error("[ServerPeerLinkProtocolService] introduction request failed", err && err.message ? err.message : err);
    });
  }

  // Build + send the signed introduction request (the SDK also creates/advances
  // the local peer-link record). Split out so triggerIntroduction stays a
  // synchronous fire-and-forget entry point.
  async _sendIntroductionRequest({ peerLinks, sdk, remote, remoteInbox, senderInboxId }) {
    if (await this._hasLiveOrPendingLink(peerLinks, remote)) return;
    const result = await peerLinks.requestPeerLinkIntroduction({
      ownerAccountId: this.ownerAccountId,
      peerAccountId: remote,
      peerInboxId: remoteInbox,
      senderInboxId,
    });
    if (!result || result.alreadyLinked) {
      if (result && result.snapshot) this._emitPeerLinkUpdated(result.snapshot);
      return;
    }
    const record = result.introductionRecord;
    if (!record || typeof record.toBytes !== "function") {
      this.logger.warn("[ServerPeerLinkProtocolService] introduction produced no request record for peer " + remote);
      return;
    }
    if (result.snapshot) this._emitPeerLinkUpdated(result.snapshot);
    await sdk.mesh.dispatch(
      {
        payloadBytes: record.toBytes(),
        objectId: "introreq_" + Date.now() + "_" + Math.random().toString(36).slice(2, 10),
        metadata: {},
      },
      buildInboxAddress({ inboxId: remoteInbox }),
    );
  }

  // True when we already hold a usable or in-flight link to the peer — used to
  // suppress redundant introductions. rehandshake_requested is our own pending
  // introduction's state; handshake_*/accept_committed/session_established are
  // live or in-flight. Only terminal-dead states (failed/rejected/degraded)
  // allow a fresh introduction.
  async _hasLiveOrPendingLink(peerLinks, peerAccountId) {
    if (typeof peerLinks.listPeerLinks !== "function") return false;
    const result = await peerLinks.listPeerLinks({ ownerAccountId: this.ownerAccountId });
    const items = result && Array.isArray(result.items) ? result.items : [];
    const match = items.find((it) => it && it.peerAccountId === peerAccountId);
    if (!match) return false;
    const dead = match.state === "failed" || match.state === "rejected" || match.state === "degraded";
    return !dead;
  }

  async _isCoMember(accountId) {
    const groupStore = this._groupStore();
    if (!groupStore || typeof groupStore.isCoMember !== "function") return false;
    try {
      return await groupStore.isCoMember({ ownerAccountId: this.ownerAccountId, accountId });
    } catch (err) {
      this.logger.warn("[ServerPeerLinkProtocolService] isCoMember check failed", err && err.message ? err.message : err);
      return false;
    }
  }

  _groupStore() {
    return this.bus.stores && this.bus.stores.groupStore ? this.bus.stores.groupStore : null;
  }

  _emitPeerLinkUpdated(snapshot, remoteDisplayName = "") {
    if (!snapshot || typeof snapshot !== "object") return;
    // Use a distinct input-event name to feed ServerEventService. The
    // canonical outbound `peer-link.updated` event is emitted by
    // ServerEventService itself after thread/contact/index materialization,
    // so emitting it from here would cause recursive re-entry.
    //
    // No groupId is forwarded. Group membership is established by the
    // explicit `member.join` op, not by peer-link snapshot semantics.
    this._emit("peerlink.protocol.snapshot", {
      peerLinkId: snapshot.peerLinkId,
      state: snapshot.state,
      sessionState: snapshot.sessionState,
      peerAccountId: snapshot.peerAccountId || null,
      remoteDisplayName: typeof remoteDisplayName === "string" ? remoteDisplayName : "",
      peerInboxId: snapshot.peerInboxId || null,
      // The invite this peer-link was opened for. Forwarded so a rejected
      // peer-link can tear down exactly the group joined via this one invite.
      activeInviteId: snapshot.activeInviteId || null,
      lastErrorCode: snapshot.lastErrorCode,
      lastErrorMessage: snapshot.lastErrorMessage,
      updatedAtMs: snapshot.updatedAtMs,
    });
  }

  _sdk() {
    return this.bus.runtime && this.bus.runtime.sdk ? this.bus.runtime.sdk : null;
  }

  _peerLinkService() {
    return this.bus.runtime && this.bus.runtime.peerLinks ? this.bus.runtime.peerLinks : null;
  }

  _ownInboxId(sdk) {
    const identity = sdk && typeof sdk.getIdentity === "function" ? sdk.getIdentity() : null;
    const sessionInbox = identity && typeof identity.localInboxId === "string" ? identity.localInboxId.trim() : "";
    if (sessionInbox) return sessionInbox;
    // Fall back to the claimed inbox id. session.localInboxId is only populated
    // once session.ready lands; the claimant's inboxId is authoritative and set
    // at bootstrap, so introductions fired before session info settles still
    // resolve a routable sender inbox.
    const claimant = this.bus.runtime && this.bus.runtime.inboxClaimant ? this.bus.runtime.inboxClaimant : null;
    return claimant && typeof claimant.inboxId === "string" ? claimant.inboxId.trim() : "";
  }
}
