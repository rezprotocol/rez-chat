import { bytesToBase64, base64ToBytes } from "@rezprotocol/sdk/client";
import { BaseServerService } from "../base/BaseServerService.js";

const DEFAULT_CLAIM_TIMEOUT_MS = 10_000;

/**
 * ServerPeerLinkProtocolService — chat-server-side handler for peer-link
 * protocol messages flowing over mailbox deposits (Shape A).
 *
 * Subscribes to `sdk.subscriptions.onMailboxDeposited`. Each deposit body is
 * parsed and routed by kind:
 *
 *   - Plaintext JSON:
 *     - `rez.peerlink.claim.req` — look up envelope in local PeerLinkService,
 *       send `claim.res` back via `sdk.mailbox.deposit`.
 *     - `rez.peerlink.claim.res` — resolve the registered claim waiter.
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
 *
 * Also owns `bus.runtime.claimWaiter` used by ServerInvitesService.acceptInvite
 * for cross-network invite envelope resolution.
 */
export class ServerPeerLinkProtocolService extends BaseServerService {
  #clock;
  #claimWaiters;

  constructor({ bus, ownerAccountId, clock = () => Date.now(), logger = console } = {}) {
    super({ bus, ownerAccountId, logger });
    this.#clock = clock;
    this.#claimWaiters = new Map();
    this.bus.runtime.claimWaiter = {
      register: (requestId, timeoutMs) => this._registerClaimWaiter(requestId, timeoutMs),
      resolve: (requestId, data, error) => this._resolveClaimWaiter(requestId, data, error),
    };
  }

  async start() {
    // Live SDK push (via MailboxPushBridge) and InboxCatchupService both
    // emit on this one bus event; we no longer subscribe to the SDK
    // directly. See MailboxPushBridge.js for the bridge contract.
    this._listen("runtime.event.mailbox.deposited", (event) => this._handleMailboxDeposited(event));
  }

  async stop() {
    for (const [, entry] of this.#claimWaiters.entries()) {
      clearTimeout(entry.timer);
      entry.reject(Object.assign(new Error("service stopped"), { code: "SERVICE_STOPPED" }));
    }
    this.#claimWaiters.clear();
    if (this.bus.runtime && this.bus.runtime.claimWaiter) {
      this.bus.runtime.claimWaiter = null;
    }
    await super.stop();
  }

  _registerClaimWaiter(requestId, timeoutMs = DEFAULT_CLAIM_TIMEOUT_MS) {
    if (typeof requestId !== "string" || !requestId.trim()) {
      throw new Error("claimWaiter.register requires non-empty requestId");
    }
    const id = requestId.trim();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#claimWaiters.delete(id);
        reject(Object.assign(new Error("claim request timed out"), { code: "CLAIM_TIMEOUT" }));
      }, timeoutMs);
      this.#claimWaiters.set(id, { resolve, reject, timer });
    });
  }

  _resolveClaimWaiter(requestId, data, error) {
    const id = typeof requestId === "string" ? requestId.trim() : "";
    if (!id) return false;
    const entry = this.#claimWaiters.get(id);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.#claimWaiters.delete(id);
    if (error) {
      entry.reject(error instanceof Error
        ? error
        : Object.assign(new Error(error.message || "claim failed"), { code: error.code || "CLAIM_FAILED" }));
    } else {
      entry.resolve(data);
    }
    return true;
  }

  async _handleMailboxDeposited(event) {
    const frame = event && typeof event === "object" ? event : {};
    const body = frame.body && typeof frame.body === "object" ? frame.body : frame;
    const ciphertextB64 = typeof body.ciphertextB64 === "string" ? body.ciphertextB64 : "";
    const mailboxId = typeof body.mailboxId === "string" ? body.mailboxId : "";
    const eventId = typeof body.eventId === "string" ? body.eventId : "";
    if (!ciphertextB64) return;

    let payloadBytes;
    try {
      payloadBytes = base64ToBytes(ciphertextB64);
    } catch {
      return;
    }

    let bodyObj = null;
    try {
      const text = new TextDecoder().decode(payloadBytes);
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        bodyObj = parsed;
      }
    } catch {
      bodyObj = null;
    }
    if (!bodyObj) return;

    // --- Plaintext peer-link protocol messages ---

    if (bodyObj.kind === "rez.peerlink.claim.res" && bodyObj.requestId) {
      const data = bodyObj.envelope
        ? { envelope: bodyObj.envelope, signatureB64: bodyObj.signatureB64 || null }
        : null;
      this._resolveClaimWaiter(bodyObj.requestId, data, bodyObj.error || null);
      return;
    }
    if (bodyObj.kind === "rez.peerlink.claim.req" && bodyObj.inviteId && bodyObj.replyInboxId) {
      await this._handleInboundClaimRequest(bodyObj);
      return;
    }

    const peerLinks = this._peerLinkService();
    if (!peerLinks) return;

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
      if (!result) return;
      this._emitPeerLinkUpdated(result.snapshot);
      return;
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
      if (!handled) return;
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
      return;
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
      if (!result) return;
      this._emitPeerLinkUpdated(result.snapshot);
      if (result.handshakePacket && result.deliverInboxId) {
        try {
          await this._sdk().mailbox.deposit({
            mailboxId: result.deliverInboxId,
            objectId: "rhresp_" + Date.now() + "_" + Math.random().toString(36).slice(2, 10),
            ciphertextB64: bytesToBase64(result.handshakePacket),
            metadata: {},
          });
        } catch (sendErr) {
          this.logger.error("[ServerPeerLinkProtocolService] rehandshake response send failed", sendErr && sendErr.message ? sendErr.message : sendErr);
        }
      }
      return;
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
      if (!handled) return;
      this._emitPeerLinkUpdated(handled.snapshot, handled.remoteDisplayName);
      return;
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
        if (decErr && decErr.code === "DECRYPT_FAILED" && decErr.rehandshakeNeeded) {
          this._triggerRehandshake({ peerAccountId: decErr.peerAccountId });
        }
        return;
      }
      if (!decResult || !(decResult.plaintextBytes instanceof Uint8Array)) return;

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
          return;
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
      this._emit("peerlink.user.message", {
        mailboxId,
        eventId,
        plaintextB64: bytesToBase64(decResult.plaintextBytes),
        senderAccountId: decryptedSender || null,
        snapshot: snapshot || null,
      });
    }
  }

  async _handleInboundClaimRequest(bodyObj) {
    const peerLinks = this._peerLinkService();
    if (!peerLinks || typeof peerLinks.claimInviteAsRemote !== "function") {
      this.logger.warn("[ServerPeerLinkProtocolService] claim.req received but peerLinkService unavailable");
      return;
    }
    const inviteId = String(bodyObj.inviteId || "").trim();
    const replyInboxId = String(bodyObj.replyInboxId || "").trim();
    const requestId = String(bodyObj.requestId || "").trim();
    if (!inviteId || !replyInboxId || !requestId) return;

    // Atomic check-and-spend: claimInviteAsRemote increments the use counter
    // and flips status → "used" before returning the envelope. This is the
    // only enforcement point for maxUses on cross-network accepts. A second
    // claim of a single-use invite — including by a freshly created account
    // — surfaces here as INVITE_USED_UP and is returned to the acceptor in
    // the claim.res error field.
    let envelopeData = null;
    let error = null;
    try {
      envelopeData = await peerLinks.claimInviteAsRemote({
        ownerAccountId: this.ownerAccountId,
        inviteId,
      });
    } catch (claimErr) {
      const code = claimErr && typeof claimErr.code === "string" && claimErr.code
        ? claimErr.code : "INVITE_NOT_FOUND";
      const message = claimErr && typeof claimErr.message === "string" && claimErr.message
        ? claimErr.message : "invite claim failed";
      this.logger.warn("[ServerPeerLinkProtocolService] invite claim refused", code, message);
      error = { code, message };
    }

    const responseBody = JSON.stringify({
      kind: "rez.peerlink.claim.res",
      requestId,
      envelope: envelopeData ? envelopeData.envelope : null,
      signatureB64: envelopeData ? envelopeData.signatureB64 : null,
      error,
    });

    const sdk = this._sdk();
    if (!sdk || !sdk.mailbox) {
      this.logger.warn("[ServerPeerLinkProtocolService] cannot send claim.res — sdk.mailbox unavailable");
      return;
    }
    try {
      await sdk.mailbox.deposit({
        mailboxId: replyInboxId,
        objectId: "clmres_" + requestId,
        ciphertextB64: bytesToBase64(new TextEncoder().encode(responseBody)),
        metadata: {},
      });
    } catch (sendErr) {
      this.logger.error("[ServerPeerLinkProtocolService] claim.res send failed", sendErr && sendErr.message ? sendErr.message : sendErr);
    }
  }

  async _sendHandshakeAck({ deliverInboxId, ownerDisplayName = "", ackNonce = null }) {
    const sdk = this._sdk();
    if (!sdk || !sdk.mailbox) return;
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
      await sdk.mailbox.deposit({
        mailboxId: deliverInboxId,
        objectId: "hsack_" + Date.now() + "_" + Math.random().toString(36).slice(2, 10),
        ciphertextB64: bytesToBase64(ackBytes),
        metadata: {},
      });
    } catch (sendErr) {
      this.logger.error("[ServerPeerLinkProtocolService] handshake.ack send failed", sendErr && sendErr.message ? sendErr.message : sendErr);
    }
  }

  _triggerRehandshake({ peerAccountId }) {
    if (!peerAccountId) return;
    const peerLinks = this._peerLinkService();
    if (!peerLinks || typeof peerLinks.requestRehandshake !== "function") return;
    peerLinks.requestRehandshake({
      ownerAccountId: this.ownerAccountId,
      peerAccountId,
      sendRehandshake: async ({ deliverInboxId, packetBytes }) => {
        const sdk = this._sdk();
        if (!sdk || !sdk.mailbox) {
          const err = new Error("sdk.mailbox unavailable for rehandshake send");
          err.code = "UNREACHABLE";
          throw err;
        }
        await sdk.mailbox.deposit({
          mailboxId: deliverInboxId,
          objectId: "rhreq_" + Date.now() + "_" + Math.random().toString(36).slice(2, 10),
          ciphertextB64: bytesToBase64(packetBytes),
          metadata: {},
        });
      },
    }).catch((rhErr) => {
      this.logger.error("[ServerPeerLinkProtocolService] requestRehandshake failed", rhErr && rhErr.message ? rhErr.message : rhErr);
    });
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
    const identity = typeof sdk.getIdentity === "function" ? sdk.getIdentity() : null;
    return identity && typeof identity.localInboxId === "string" ? identity.localInboxId.trim() : "";
  }
}
