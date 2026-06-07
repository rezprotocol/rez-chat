/**
 * InboundDepositPipeline — the SINGLE, serialized inbound path for mailbox
 * deposits. Both the live SDK push (MailboxPushBridge) and the catch-up drain
 * (InboxCatchupService) feed deposits here; this pipeline processes them ONE AT
 * A TIME, IN ORDER, awaiting each to full completion before the next.
 *
 * Why serialized (the bug this fixes): processing a deposit is a directive that
 * must complete-and-confirm before the next — `bus.emit` cannot do that (it
 * calls async handlers fire-and-forget and never awaits them). The old code
 * re-emitted each buffered deposit without awaiting, so N deposits' apply-chains
 * ran concurrently. A peer's group MESSAGE then reached the membership gate
 * (ServerEventService) BEFORE that peer's `member.join` committed, and the
 * fail-closed gate dropped the message permanently (relay withdraws on drain).
 * Same race left the roster missing members and lost messages across a
 * handshake. See memory feedback_inbound_deposit_pipeline_must_be_awaited_calls.
 *
 * Per-deposit order (mirrors the old dual-subscriber behaviour, now awaited):
 *   1. peerLinkProtocol.processDeposit(frame) — decrypts; applies protocol
 *      bodies (handshake/ack/reject/rehandshake/delivery-ack) in place; RETURNS
 *      a decrypted user message (if any) rather than emitting it.
 *   2. if a user message surfaced → events.applyUserMessage(userMessage).
 *   3. events.processDeposit(frame) — the plaintext-deposit path (no-ops for
 *      E2EE frames, which it skips at its own ingress).
 *
 * Global ordering: every submit() chains onto the previous, so a live push that
 * arrives mid-drain still serializes behind the in-flight deposit rather than
 * racing it.
 */
export class InboundDepositPipeline {
  #peerLinkProtocol;
  #events;
  #processedLog;
  #logger;
  #tail;

  constructor({ peerLinkProtocol, events, processedLog = null, logger = console } = {}) {
    if (!peerLinkProtocol || typeof peerLinkProtocol.processDeposit !== "function") {
      throw new Error("InboundDepositPipeline requires peerLinkProtocol.processDeposit");
    }
    if (!events || typeof events.processDeposit !== "function" || typeof events.applyUserMessage !== "function") {
      throw new Error("InboundDepositPipeline requires events.processDeposit + events.applyUserMessage");
    }
    this.#peerLinkProtocol = peerLinkProtocol;
    this.#events = events;
    // Optional persisted (mailbox,event) dedup. Prevents re-decrypting a deposit
    // that was already consumed via the live push path when the catch-up drain
    // re-fetches it on a later cold boot — a re-decrypt fails the double ratchet.
    this.#processedLog = processedLog && typeof processedLog.has === "function"
      && typeof processedLog.mark === "function"
      ? processedLog
      : null;
    this.#logger = logger;
    this.#tail = Promise.resolve();
  }

  /**
   * Enqueue one raw deposit frame for in-order processing. Returns a promise
   * that resolves when THIS deposit is fully processed, with a status object the
   * consume layers (catch-up drain + live push bridge) use to decide whether to
   * ACK/delete the relay buffer copy:
   *   - `consumed`         — the deposit was definitively handled (handshake
   *                          established, ack/reject applied, message decrypted) or
   *                          is a dedup hit. The ONLY safe-to-ack signal.
   *   - `decryptOk`        — the (non-idempotent) decrypt succeeded this pass.
   *   - `alreadyProcessed` — skipped as a dedup hit (consumed earlier via push).
   *   - `applied`          — the (idempotent) downstream applies ran without error.
   * A deposit is safe to ACK iff `consumed`. A deposit that could not be decrypted
   * yet (no session) resolves `{ consumed:false }` so the caller LEAVES it buffered
   * for a later retry — the decrypt did not commit the ratchet, so a retry can
   * still succeed once the establishing handshake ahead of it is applied. Handlers
   * are caught internally so one bad deposit never wedges the queue or rejects a
   * caller.
   *
   * @param {{ body?: object, mailboxId?: string, eventId?: string, ciphertextB64?: string }} frame
   * @returns {Promise<{ consumed: boolean, decryptOk: boolean, alreadyProcessed: boolean, applied: boolean }>}
   */
  submit(frame) {
    const run = this.#tail.then(() => this.#processOne(frame));
    // Keep the chain alive even if this deposit throws — the next submit must
    // still run. `run` resolves with the status object (#processOne catches
    // internally); the .catch here is only a backstop for the tail chain.
    this.#tail = run.catch(() => {});
    return run;
  }

  #frameIds(frame) {
    const body = frame && frame.body && typeof frame.body === "object" ? frame.body : (frame || {});
    const mailboxId = typeof body.mailboxId === "string" ? body.mailboxId : "";
    const eventId = typeof body.eventId === "string" ? body.eventId : "";
    return { mailboxId, eventId };
  }

  async #processOne(frame) {
    const { mailboxId, eventId } = this.#frameIds(frame);
    // Skip a deposit already decrypted + consumed earlier (typically via the
    // live push path) and now re-fetched by the catch-up drain. Re-decrypting it
    // would fail the (already-advanced) double ratchet and could swallow the
    // genuinely-new deposit that follows. Downstream applies are canonical-key
    // idempotent; the decrypt is the one non-idempotent step, so dedup here.
    if (this.#processedLog && eventId) {
      let already = false;
      try {
        already = await this.#processedLog.has(mailboxId, eventId);
      } catch (err) {
        this.#logger.error("[InboundDepositPipeline] processed-log lookup failed: "
          + (err && err.message ? err.message : err));
      }
      // Already decrypted + consumed earlier (live push). The buffer copy is
      // redundant — report consumed so the drain acks it; never re-decrypt.
      if (already) return { consumed: true, decryptOk: false, alreadyProcessed: true, applied: false };
    }

    // processDeposit now returns an honest status: { consumed, decryptOk,
    // userMessage? }. `consumed` is the ack signal — TRUE only when the deposit
    // was definitively handled (handshake established, ack/reject applied, or a
    // message decrypted). A deposit it could not decrypt yet (no session) returns
    // consumed:false so the caller LEAVES it buffered to retry — acking it would
    // destroy a message we simply can't read YET (the desktop data-loss bug).
    let status = null;
    try {
      status = await this.#peerLinkProtocol.processDeposit(frame);
    } catch (err) {
      this.#logger.error("[InboundDepositPipeline] peer-link decrypt/handle failed: "
        + (err && err.message ? err.message : err));
      status = null;
    }
    const consumed = Boolean(status && status.consumed);
    const decryptOk = Boolean(status && status.decryptOk);
    // Mark processed only after a real (non-idempotent) decrypt, so a re-fetch
    // never re-runs the advanced ratchet. A deposit left for retry stays unmarked.
    if (this.#processedLog && eventId && decryptOk) {
      try {
        await this.#processedLog.mark(mailboxId, eventId);
      } catch (err) {
        this.#logger.error("[InboundDepositPipeline] processed-log mark failed: "
          + (err && err.message ? err.message : err));
      }
    }
    let applied = true;
    if (status && status.userMessage) {
      try {
        await this.#events.applyUserMessage(status.userMessage);
      } catch (err) {
        applied = false;
        this.#logger.error("[InboundDepositPipeline] user-message apply failed: "
          + (err && err.message ? err.message : err));
      }
    }
    try {
      await this.#events.processDeposit(frame);
    } catch (err) {
      applied = false;
      this.#logger.error("[InboundDepositPipeline] plaintext deposit apply failed: "
        + (err && err.message ? err.message : err));
    }
    // Note (D2): `consumed` reflects what processDeposit decided; we keep it true
    // even when an idempotent apply logged an error — re-decrypt is impossible and
    // the applies are canonical-key idempotent, so a redelivery would not recover
    // them anyway. Only a genuinely-unconsumed (undecryptable-yet) deposit is left
    // buffered for retry.
    return { consumed, decryptOk, alreadyProcessed: false, applied };
  }
}
