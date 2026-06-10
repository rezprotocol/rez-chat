import { base64ToBytes, buildInboxAddress, bytesToBase64 } from "@rezprotocol/sdk/client";
import { BaseServerService } from "../base/BaseServerService.js";

// Minimum gap between recovery-invite triggers for the SAME peer. The inbound
// pipeline can surface a backlog of undecryptable deposits in a tight burst, so
// without a synchronous gate each one would mint a fresh recovery invite — a
// storm. One attempt per window is enough: it either heals the link or the
// window expires and recovery retries. This timestamp also doubles as the
// "outstanding recovery invite" marker for the glare tiebreak (an invite sent
// within RECOVERY_INVITE_TTL_MS is considered still in flight). 30s so it
// comfortably exceeds a live re-invite round-trip (invite → accept → handshake →
// ack over multi-hop relays); a shorter window let a second invite fire mid-flight
// and re-key the peer, churning the session. The healthy-on-establish guard in
// #commitSession is the primary convergence lever; this is the backstop.
const RECOVERY_INVITE_TRIGGER_COOLDOWN_MS = 30_000;
// How long a recovery invite stays valid. Deliberately SHORT: a desynced link
// heals in seconds, and a short TTL means a stale/superseded/replayed invite
// auto-rejects (INVITE_EXPIRED) instead of re-establishing a now-wrong session —
// the property that lets crossing invites converge without bespoke glare state.
const RECOVERY_INVITE_TTL_MS = 5 * 60 * 1000;
// Inbox message kind carrying a directed recovery invite ({envelope,
// signatureB64}). A plain JSON body like rez.peerlink.handshake.ack.v2 — NOT a
// new e2ee packet type. Recovery reuses the proven invite/accept path verbatim.
const RECOVERY_INVITE_KIND = "rez.peerlink.recovery-invite.v1";

// SENDER-SIDE recovery detection (the multi-peer-link healing path). An inbound
// E2EE packet is opaque — it carries no sender identity — so the recipient
// cannot attribute an undecryptable message to a specific link when it holds
// more than one (every idle link looks equally guilty; that ambiguity is why a
// real group with several contacts never healed via the decrypt-miss trigger).
// The SENDER, however, knows EXACTLY who it fanned a group message out to. So we
// also detect a broken link from the send side: every outbound group message to
// a co-member is expected to come back as a delivery-ack (the recipient auto-acks
// any message it decrypts). A co-member whose link to us is desynced can never
// ack, so its unacked count grows monotonically; a healthy member acks and resets
// to zero. When a peer accrues SENDER_RECOVERY_UNACKED_THRESHOLD unacked group
// sends AND none has been acked for SENDER_RECOVERY_UNACKED_TIMEOUT_MS, we
// re-invite THAT peer — exact attribution, no collateral re-key of healthy links.
// Reuses _triggerRecoveryInvite (+ its per-peer cooldown) verbatim; only the
// TRIGGER moves to where the sender identity is known for free.
const SENDER_RECOVERY_UNACKED_THRESHOLD = 3;
const SENDER_RECOVERY_UNACKED_TIMEOUT_MS = 45_000;
// REZ-4: ack-absence is not proof of desync — a relay can selectively drop the
// E2EE delivery-acks. If we DECRYPTED a message from a peer within this window the
// link is demonstrably alive in the receive direction, so sender-side recovery
// must NOT re-key it (that churn is exactly what an ack-dropping relay would
// weaponise). Mirrors the recipient-side HEALTHY_SESSION_DECRYPT_GUARD.
const SENDER_RECOVERY_HEALTHY_GUARD_MS = 45_000;
// REZ-5: global rate limit across ALL peers. The per-peer cooldown alone lets a
// crafted member.contact fan-out (or an ack-drop campaign) mint N invites at once;
// this caps the node's total recovery-invite output per rolling window.
const RECOVERY_INVITE_GLOBAL_WINDOW_MS = 60_000;
const RECOVERY_INVITE_GLOBAL_MAX = 30;
// REZ-5: hard cap on the per-peer bookkeeping maps so a node that talks to many
// distinct peers over its lifetime cannot leak unbounded memory.
const RECOVERY_MAP_MAX_ENTRIES = 4096;

/**
 * ServerPeerLinkProtocolService — chat-server-side handler for peer-link
 * protocol messages flowing over mailbox deposits (Shape A).
 *
 * Each deposit body is parsed and routed by kind:
 *
 *   - `x3dh.handshake.v2` (regular) — handleIncomingHandshakePacket; on success,
 *     send a handshake.ack to the acceptor's inbox. The SDK handler verifies the
 *     envelope signature and derives senderAccountId from the signed pubkey —
 *     this service never trusts plaintext senderAccountId on the wire. This is
 *     also the RESPONSE leg of recovery (the inviter completes the re-invite).
 *   - `rez.peerlink.recovery-invite.v1` — a directed re-invite for link RECOVERY
 *     (desynced DM link) or co-member BOOTSTRAP (group member with no link yet).
 *     Glare tiebreak + authz gate, then acceptInvite({forceReestablish}) reuses
 *     the normal accept path; the response rides back as a regular handshake.
 *   - `rez.peerlink.handshake.ack.v2` / `.reject.v1` — ack/reject handlers.
 *   - regular E2EE deposit — decrypt via PeerLinkService; a delivery-ack emits
 *     `delivery.ack`; otherwise the decrypted user message is returned for
 *     ServerEventService. A total decrypt miss (THREAD_NOT_READY) triggers a
 *     recovery invite for the single eligible candidate.
 */
export class ServerPeerLinkProtocolService extends BaseServerService {
  #clock;
  // peerAccountId -> last recovery-invite trigger time (ms). Synchronous burst
  // gate AND the glare "outstanding invite" marker; see the consts above.
  #recoveryInviteAtMsByPeer = new Map();
  // peerAccountId -> { count, firstAtMs } outbound group messages awaiting an
  // end-to-end delivery-ack. Reset to empty on ANY ack from that peer (a single
  // ack proves the us->peer direction works now); a peer that never acks crosses
  // the threshold and gets re-invited. The single source of sender-side desync
  // evidence; see SENDER_RECOVERY_* consts above.
  #outstandingGroupSendsByPeer = new Map();
  // REZ-1: peerAccountId -> last time we ACCEPTED an inbound recovery invite from
  // them. Receive-side cooldown so an authorised peer cannot force unbounded
  // re-keys of our live session (the outbound cooldown only gates invites WE mint).
  #inboundRecoveryAtMsByPeer = new Map();
  // REZ-4: peerAccountId -> last time we successfully DECRYPTED an inbound message
  // from them. Proves the link is alive in the receive direction; suppresses
  // sender-side ack-timeout recovery for a demonstrably-live peer.
  #lastInboundDecryptAtMsByPeer = new Map();
  // REZ-5: timestamps of recovery invites we have minted, within the rolling
  // global-rate-limit window. Pruned on each trigger.
  #recoveryInviteTimestamps = [];

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
        + " bytes=" + payloadBytes.length,
      );
    }

    // --- Plaintext peer-link protocol messages ---

    const peerLinks = this._peerLinkService();
    if (!peerLinks) return;

    // Regular peer-link handshake — ALSO the response leg of a recovery invite
    // (the inviter completes the re-invite here, identical to a first accept).
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

    // Recovery invite (directed re-invite). Replaces the bespoke rehandshake +
    // introduction request paths: a peer whose link to us desynced — or a group
    // co-member we have no link to yet — sends us a fresh, short-lived invite
    // ({envelope, signatureB64}). We accept it through the normal invite path
    // (forceReestablish so a live-but-broken link is re-keyed), which sends the
    // handshake back as a regular x3dh.handshake.v2 the inviter completes above.
    if (bodyObj.kind === RECOVERY_INVITE_KIND) {
      return await this._handleIncomingRecoveryInvite(bodyObj);
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
        // recovery threshold — zero or ambiguous (>1) candidates are left to
        // retry, never guessed. The per-peer trigger cooldown is the burst gate.
        if (isThreadNotReady && Array.isArray(decErr.recoveryCandidates)) {
          const eligible = decErr.recoveryCandidates.filter((c) => c && c.rehandshakeNeeded === true);
          if (eligible.length === 1) {
            this._triggerRecoveryInvite({ peerAccountId: eligible[0].peerAccountId });
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

      // The cryptographically-authenticated sender of THIS packet (from the
      // decrypted peer-link snapshot). Never a plaintext field.
      const snapshot = decResult.snapshot;
      const decryptedSender = snapshot && typeof snapshot.peerAccountId === "string"
        ? snapshot.peerAccountId.trim() : "";
      // REZ-4: record that this peer's link is alive in the receive direction so
      // sender-side ack-timeout recovery won't re-key a demonstrably-live link.
      if (decryptedSender) {
        this.#lastInboundDecryptAtMsByPeer.set(decryptedSender, this.#clock());
      }

      try {
        const innerText = new TextDecoder().decode(decResult.plaintextBytes);
        const inner = JSON.parse(innerText);
        if (inner && inner.kind === "rez.delivery.ack"
            && typeof inner.senderAccountId === "string"
            && Array.isArray(inner.messageIds)) {
          // REZ-7: trust the cryptographically-authenticated decrypt sender, NOT
          // the plaintext senderAccountId. A peer must not be able to clear
          // ANOTHER peer's recovery state or flip another peer's delivery status
          // by naming them in the ack body.
          if (decryptedSender && inner.senderAccountId.trim() !== decryptedSender) {
            this.logger.warn("[ServerPeerLinkProtocolService] delivery-ack sender mismatch (claimed "
              + inner.senderAccountId.trim() + " != authenticated " + decryptedSender + "); ignoring");
            return { consumed: true, decryptOk: true };
          }
          // A delivery-ack proves THIS peer decrypted a message we sent — the
          // us->peer direction is healthy right now. Clear its unacked tally so
          // sender-side recovery never re-invites a live link.
          this._noteDeliveryAckReceived(decryptedSender);
          this._emit("delivery.ack", {
            senderAccountId: decryptedSender,
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

  // Initiate link RECOVERY by re-inviting a peer — the single recovery path for
  // BOTH a desynced DM link and a group co-member we have no link to yet. Mints a
  // fresh, short-lived direct invite and dispatches it to the peer's inbox; the
  // peer accepts (forceReestablish) and completes the handshake back to us, so
  // recovery reuses the proven invite/accept machinery verbatim. Fire-and-forget:
  // failures are logged, never thrown into the deposit pipeline.
  //
  // Glare-free by construction: only the asymmetric invite/accept roles run, and
  // if both sides re-invite at once the accept-side tiebreak
  // (_handleIncomingRecoveryInvite) keeps a single matched pair; the short invite
  // TTL retires superseded invites. `peerInboxId` is supplied for the group
  // bootstrap case (from member.contact); for DM recovery it is resolved from the
  // existing peer-link snapshot.
  _triggerRecoveryInvite({ peerAccountId, peerInboxId = "" } = {}) {
    const remote = typeof peerAccountId === "string" ? peerAccountId.trim() : "";
    if (!remote || remote === this.ownerAccountId) return;
    // Synchronous per-peer cooldown (also the glare "outstanding invite" marker).
    // Read here; commit the timestamp only once we're actually about to dispatch,
    // so an early-return (no sdk) does not start a cooldown that delays a retry.
    const nowMs = this.#clock();
    this.#pruneStaleMap(this.#recoveryInviteAtMsByPeer, nowMs, RECOVERY_INVITE_TTL_MS);
    const lastAtMs = this.#recoveryInviteAtMsByPeer.get(remote);
    if (typeof lastAtMs === "number" && nowMs - lastAtMs < RECOVERY_INVITE_TRIGGER_COOLDOWN_MS) return;
    // REZ-5: global rate limit across all peers. Prune the rolling window, then cap
    // total mints per window so one crafted fan-out can't burst the whole group.
    this.#recoveryInviteTimestamps = this.#recoveryInviteTimestamps.filter(
      (t) => nowMs - t < RECOVERY_INVITE_GLOBAL_WINDOW_MS);
    if (this.#recoveryInviteTimestamps.length >= RECOVERY_INVITE_GLOBAL_MAX) {
      this.logger.warn("[ServerPeerLinkProtocolService] recovery invite suppressed — global rate limit reached");
      return;
    }
    const peerLinks = this._peerLinkService();
    if (!peerLinks || typeof peerLinks.createInvite !== "function") return;
    const sdk = this._sdk();
    if (!sdk || !sdk.mesh) {
      this.logger.warn("[ServerPeerLinkProtocolService] recovery invite skipped — sdk.mesh unavailable");
      return;
    }
    this.#recoveryInviteAtMsByPeer.set(remote, nowMs);
    this.#recoveryInviteTimestamps.push(nowMs);
    const remoteInbox = typeof peerInboxId === "string" ? peerInboxId.trim() : "";
    this._sendRecoveryInvite({ peerLinks, sdk, remote, peerInboxId: remoteInbox }).catch((err) => {
      this.logger.error("[ServerPeerLinkProtocolService] recovery invite send failed", err && err.message ? err.message : err);
    });
  }

  // Mint a fresh, short-lived direct invite and dispatch it to the peer's inbox
  // as a recovery-invite body. Split out so _triggerRecoveryInvite stays a
  // synchronous fire-and-forget entry point. The invite envelope binds OUR inbox
  // as the reply target (createInvite's inviteBinding capabilityId), so the
  // peer's accept handshake routes back to us.
  async _sendRecoveryInvite({ peerLinks, sdk, remote, peerInboxId }) {
    const deliverInboxId = peerInboxId || await this._resolvePeerInboxId(peerLinks, remote);
    if (!deliverInboxId) {
      this.logger.warn("[ServerPeerLinkProtocolService] recovery invite skipped — no inbox for peer " + remote);
      return;
    }
    // The invite's reply binding (our persistent claimed inbox) is configured
    // intrinsically on PeerLinkService at construction (see bootstrapChatServer),
    // so createInvite anchors it automatically — recovery does NOT hand-pass it.
    // createInvite fails loud if no binding is configured, so a bindingless invite
    // can no longer be silently produced.
    const created = await peerLinks.createInvite({
      ownerAccountId: this.ownerAccountId,
      kind: "direct",
      maxUses: 1,
      expiresAtMs: this.#clock() + RECOVERY_INVITE_TTL_MS,
    });
    const inviteId = created && typeof created.inviteId === "string" ? created.inviteId : "";
    if (!inviteId) {
      this.logger.warn("[ServerPeerLinkProtocolService] recovery invite produced no inviteId for peer " + remote);
      return;
    }
    const envelopeData = await peerLinks.getStoredInviteEnvelope(this.ownerAccountId, inviteId);
    if (!envelopeData || !envelopeData.envelope || typeof envelopeData.signatureB64 !== "string") {
      this.logger.warn("[ServerPeerLinkProtocolService] recovery invite envelope missing for peer " + remote);
      return;
    }
    const payloadBytes = new TextEncoder().encode(JSON.stringify({
      kind: RECOVERY_INVITE_KIND,
      envelope: envelopeData.envelope,
      signatureB64: envelopeData.signatureB64,
    }));
    await sdk.mesh.dispatch(
      {
        payloadBytes,
        objectId: "recinv_" + Date.now() + "_" + Math.random().toString(36).slice(2, 10),
        metadata: {},
      },
      buildInboxAddress({ inboxId: deliverInboxId }),
    );
  }

  // Record that we fanned an outbound GROUP message out to a co-member and now
  // expect an end-to-end delivery-ack from them. Called once per delivered
  // recipient by ServerMessagesService#sendGroupFanOut. A peer that never acks
  // accrues unacked sends until sender-side recovery re-invites it (exact
  // attribution — we KNOW who we sent to, unlike the opaque recipient-side path).
  // Synchronous bookkeeping; also sweeps so an actively-sending user heals fast.
  recordOutboundGroupMessage({ peerAccountId } = {}) {
    const remote = typeof peerAccountId === "string" ? peerAccountId.trim() : "";
    if (!remote || remote === this.ownerAccountId) return;
    const nowMs = this.#clock();
    const entry = this.#outstandingGroupSendsByPeer.get(remote);
    if (entry) {
      entry.count += 1;
    } else {
      this.#outstandingGroupSendsByPeer.set(remote, { count: 1, firstAtMs: nowMs });
    }
    this._sweepStaleDeliveries();
  }

  // Clear a peer's unacked tally — a delivery-ack from them proves the us->peer
  // direction is healthy. Also sweeps the rest: acks flowing from healthy members
  // give the sweep cadence even when WE have stopped sending into a dead group.
  // Protected (not private) as a test seam, mirroring _triggerRecoveryInvite.
  _noteDeliveryAckReceived(peerAccountId) {
    const remote = typeof peerAccountId === "string" ? peerAccountId.trim() : "";
    if (!remote) return;
    this.#outstandingGroupSendsByPeer.delete(remote);
    this._sweepStaleDeliveries();
  }

  // Re-invite every co-member whose link looks desynced from the SEND side:
  // SENDER_RECOVERY_UNACKED_THRESHOLD+ outbound group messages with no ack for
  // SENDER_RECOVERY_UNACKED_TIMEOUT_MS. Resets the peer's window after triggering
  // (a fresh re-invite needs fresh evidence); _triggerRecoveryInvite's own 30s
  // per-peer cooldown spaces retries while a re-invite is in flight. Public for
  // direct test drive; otherwise invoked on every send and every inbound ack.
  _sweepStaleDeliveries() {
    const nowMs = this.#clock();
    this.#pruneStaleMap(this.#lastInboundDecryptAtMsByPeer, nowMs, SENDER_RECOVERY_HEALTHY_GUARD_MS * 4);
    for (const [peerAccountId, entry] of [...this.#outstandingGroupSendsByPeer.entries()]) {
      if (!entry || entry.count < SENDER_RECOVERY_UNACKED_THRESHOLD) continue;
      if (nowMs - entry.firstAtMs < SENDER_RECOVERY_UNACKED_TIMEOUT_MS) continue;
      // REZ-4: ack absence is not proof of desync — a relay can selectively drop
      // delivery-acks. If we DECRYPTED a message from this peer recently, the link
      // is demonstrably alive; re-keying would be churn a relay could weaponise to
      // pin the link in perpetual re-establishment. Reset the window and skip.
      const lastDecryptAtMs = this.#lastInboundDecryptAtMsByPeer.get(peerAccountId);
      if (typeof lastDecryptAtMs === "number" && nowMs - lastDecryptAtMs < SENDER_RECOVERY_HEALTHY_GUARD_MS) {
        this.#outstandingGroupSendsByPeer.set(peerAccountId, { count: 0, firstAtMs: nowMs });
        continue;
      }
      // Fresh window so we don't immediately re-evaluate the same peer; the next
      // unacked sends rebuild evidence if this recovery attempt doesn't take.
      this.#outstandingGroupSendsByPeer.set(peerAccountId, { count: 0, firstAtMs: nowMs });
      this._triggerRecoveryInvite({ peerAccountId });
    }
  }

  // REZ-5: keep the per-peer bookkeeping maps bounded — drop entries older than
  // maxAgeMs, then hard-cap total size (oldest-insertion-first) so a node that
  // talks to many distinct peers over its lifetime cannot leak unbounded memory.
  #pruneStaleMap(map, nowMs, maxAgeMs) {
    for (const [key, val] of map) {
      const at = typeof val === "number"
        ? val
        : (val && typeof val.firstAtMs === "number" ? val.firstAtMs : 0);
      if (nowMs - at >= maxAgeMs) map.delete(key);
    }
    if (map.size > RECOVERY_MAP_MAX_ENTRIES) {
      let excess = map.size - RECOVERY_MAP_MAX_ENTRIES;
      for (const key of map.keys()) {
        if (excess-- <= 0) break;
        map.delete(key);
      }
    }
  }

  // Accept an inbound recovery invite: glare tiebreak + authz gate, then reuse
  // the normal acceptInvite path (forceReestablish so a live-but-broken link is
  // re-keyed). The handshake response rides back as a regular x3dh.handshake.v2
  // the inviter completes via handleIncomingHandshakePacket. Returns a pipeline
  // consume status (see processDeposit).
  async _handleIncomingRecoveryInvite(bodyObj) {
    const peerLinks = this._peerLinkService();
    const sdk = this._sdk();
    if (!peerLinks || typeof peerLinks.acceptInvite !== "function" || !sdk || !sdk.mesh) {
      return { consumed: false, decryptOk: false, reason: "recovery-invite-unready" };
    }
    const envelope = bodyObj && typeof bodyObj.envelope === "object" ? bodyObj.envelope : null;
    const signatureB64 = typeof bodyObj.signatureB64 === "string" ? bodyObj.signatureB64 : "";
    if (!envelope || !signatureB64) {
      return { consumed: true, decryptOk: false, reason: "recovery-invite-malformed" };
    }
    const sender = typeof envelope.creatorAccountId === "string" ? envelope.creatorAccountId.trim() : "";
    if (!sender || sender === this.ownerAccountId) {
      return { consumed: true, decryptOk: false, reason: "recovery-invite-bad-sender" };
    }

    // REZ-1: the envelope's declared creator MUST be the identity that signed it.
    // acceptInvite verifies the signature against `signerRef` and the verifier
    // binds signerRef.accountId to hash(signerRef.signerPublicKeyB64) — but it does
    // NOT bind signerRef.accountId to creatorAccountId. Without this check a peer
    // could set creatorAccountId=Alice (a co-member, so the authz gate below
    // passes) while signing with their OWN self-consistent signerRef, and drive a
    // forceReestablish teardown of OUR live session with Alice — a cross-target
    // session-reset DoS. Binding signer==creator means only the real account
    // holder (who can sign for that key) can recover-invite as that identity.
    const signerRef = envelope && typeof envelope.signerRef === "object" ? envelope.signerRef : null;
    const signerAccountId = signerRef && typeof signerRef.accountId === "string" ? signerRef.accountId.trim() : "";
    if (signerAccountId !== sender) {
      this.logger.warn("[ServerPeerLinkProtocolService] recovery invite signerRef/creator mismatch (signer "
        + (signerAccountId || "<none>") + " != creator " + sender + "); dropping");
      return { consumed: true, decryptOk: false, reason: "recovery-invite-signer-mismatch" };
    }

    const nowMs = this.#clock();
    // REZ-1: receive-side rate limit. A valid recovery invite re-keys our live
    // session with this peer (discarding the working ratchet); without a receive
    // gate an authorised co-member could force unbounded re-keys. The outbound
    // cooldown (#recoveryInviteAtMsByPeer) only throttles invites WE mint. One
    // re-key per peer per window is enough to heal a genuinely broken link.
    this.#pruneStaleMap(this.#inboundRecoveryAtMsByPeer, nowMs, RECOVERY_INVITE_TTL_MS);
    const lastInboundAtMs = this.#inboundRecoveryAtMsByPeer.get(sender);
    if (typeof lastInboundAtMs === "number" && nowMs - lastInboundAtMs < RECOVERY_INVITE_TRIGGER_COOLDOWN_MS) {
      return { consumed: true, decryptOk: true, reason: "recovery-invite-throttled" };
    }

    // GLARE TIEBREAK. If we ALSO have a recovery invite outstanding to this sender
    // and WE are the canonical inviter (smaller accountId wins), ignore theirs —
    // ours stands and they will accept it. Otherwise proceed; one matched pair
    // results regardless of who detected the break first.
    const lastAtMs = this.#recoveryInviteAtMsByPeer.get(sender);
    const haveOutstanding = typeof lastAtMs === "number" && (this.#clock() - lastAtMs) < RECOVERY_INVITE_TTL_MS;
    if (haveOutstanding && this.ownerAccountId < sender) {
      return { consumed: true, decryptOk: true, reason: "recovery-invite-glare-deferred" };
    }

    // AUTHZ. Accept only from a peer we already know: an existing peer-link (DM
    // recovery) or a co-member (group bootstrap). For an unknown sender the
    // member.contact announcing them may not have arrived yet — leave the deposit
    // BUFFERED (not consumed) so a later drain retries rather than dropping a
    // legitimate co-member bootstrap.
    const authorized = await this._hasExistingLink(peerLinks, sender) || await this._isCoMember(sender);
    if (!authorized) {
      return { consumed: false, decryptOk: false, reason: "recovery-invite-unauthorized" };
    }

    // Commit the receive-side cooldown now (before the re-key): even a re-key that
    // later fails counts toward the throttle so a peer cannot hammer us (REZ-1).
    this.#inboundRecoveryAtMsByPeer.set(sender, nowMs);
    const senderInboxId = this._ownInboxId(sdk);
    let result;
    try {
      result = await peerLinks.acceptInvite({
        envelope,
        signatureB64,
        acceptorAccountId: this.ownerAccountId,
        senderInboxId: senderInboxId || null,
        forceReestablish: true,
        sendHandshake: async ({ deliverInboxId, handshakePacket }) => {
          const target = String(deliverInboxId || "").trim();
          if (!target) {
            const err = new Error("recovery invite sendHandshake: no target inbox");
            err.code = "UNREACHABLE";
            throw err;
          }
          const objectId = "hs_" + Date.now() + "_" + Math.random().toString(36).slice(2, 10);
          await sdk.mesh.dispatch(
            { payloadBytes: handshakePacket.toBytes(), objectId, metadata: {} },
            buildInboxAddress({ inboxId: target }),
          );
          return { packetId: objectId };
        },
      });
    } catch (err) {
      // A stale/superseded invite auto-rejecting (the glare TTL doing its job) is
      // benign — consume it (nothing to retry). Other errors leave it buffered.
      const code = err && err.code ? err.code : "";
      if (code === "INVITE_EXPIRED" || code === "INVITE_SIGNATURE_INVALID") {
        return { consumed: true, decryptOk: false, reason: "recovery-invite-" + code };
      }
      this.logger.error("[ServerPeerLinkProtocolService] recovery invite accept failed", err && err.message ? err.message : err);
      return { consumed: false, decryptOk: false, reason: "recovery-invite-accept-error" };
    }
    if (result && result.snapshot) this._emitPeerLinkUpdated(result.snapshot);
    return { consumed: true, decryptOk: true };
  }

  // True when we already hold ANY peer-link record to the peer (any state).
  // Recovery authorization: an existing link means we know this contact, so an
  // inbound recovery invite from them is legitimate.
  async _hasExistingLink(peerLinks, peerAccountId) {
    if (typeof peerLinks.listPeerLinks !== "function") return false;
    const result = await peerLinks.listPeerLinks({ ownerAccountId: this.ownerAccountId });
    const items = result && Array.isArray(result.items) ? result.items : [];
    return items.some((it) => it && it.peerAccountId === peerAccountId);
  }

  // Group co-member BOOTSTRAP: establish a link with a co-member we have no
  // usable/in-flight link to yet, by re-inviting them (same recovery path as a
  // desynced DM, just triggered by member.contact instead of a decrypt miss).
  // Unlike DM recovery — which re-keys a broken-but-established link — this SKIPS
  // when a live or establishing link already exists, so it never needlessly
  // re-keys a healthy link. Both co-members may fire this; the accept-side glare
  // tiebreak keeps a single matched pair. Fire-and-forget (never throws).
  async bootstrapCoMemberLink({ peerAccountId, peerInboxId } = {}) {
    const remote = typeof peerAccountId === "string" ? peerAccountId.trim() : "";
    if (!remote || remote === this.ownerAccountId) return;
    try {
      const peerLinks = this._peerLinkService();
      if (!peerLinks) return;
      if (await this._hasLiveOrPendingLink(peerLinks, remote)) return;
      this._triggerRecoveryInvite({ peerAccountId: remote, peerInboxId });
    } catch (err) {
      this.logger.error("[ServerPeerLinkProtocolService] co-member bootstrap failed", err && err.message ? err.message : err);
    }
  }

  // True when we hold a live or in-flight link to the peer (anything but a
  // terminal-dead failed/rejected/degraded). Suppresses redundant co-member
  // bootstrap invites for links that are already healthy or establishing.
  async _hasLiveOrPendingLink(peerLinks, peerAccountId) {
    if (typeof peerLinks.listPeerLinks !== "function") return false;
    const result = await peerLinks.listPeerLinks({ ownerAccountId: this.ownerAccountId });
    const items = result && Array.isArray(result.items) ? result.items : [];
    const match = items.find((it) => it && it.peerAccountId === peerAccountId);
    if (!match) return false;
    const dead = match.state === "failed" || match.state === "rejected" || match.state === "degraded";
    return !dead;
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
    // at bootstrap, so recovery invites fired before session info settles still
    // resolve a routable sender inbox.
    const claimant = this.bus.runtime && this.bus.runtime.inboxClaimant ? this.bus.runtime.inboxClaimant : null;
    return claimant && typeof claimant.inboxId === "string" ? claimant.inboxId.trim() : "";
  }
}
