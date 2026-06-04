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
  #logger;
  #tail;

  constructor({ peerLinkProtocol, events, logger = console } = {}) {
    if (!peerLinkProtocol || typeof peerLinkProtocol.processDeposit !== "function") {
      throw new Error("InboundDepositPipeline requires peerLinkProtocol.processDeposit");
    }
    if (!events || typeof events.processDeposit !== "function" || typeof events.applyUserMessage !== "function") {
      throw new Error("InboundDepositPipeline requires events.processDeposit + events.applyUserMessage");
    }
    this.#peerLinkProtocol = peerLinkProtocol;
    this.#events = events;
    this.#logger = logger;
    this.#tail = Promise.resolve();
  }

  /**
   * Enqueue one raw deposit frame for in-order processing. Returns a promise
   * that resolves when THIS deposit is fully applied (so the catch-up drain can
   * `await` it before advancing its cursor). A thrown handler is logged and
   * swallowed so one bad deposit never wedges the queue or rejects a caller.
   *
   * @param {{ body?: object, mailboxId?: string, eventId?: string, ciphertextB64?: string }} frame
   * @returns {Promise<void>}
   */
  submit(frame) {
    const run = this.#tail.then(() => this.#processOne(frame));
    // Keep the chain alive even if this deposit throws — the next submit must
    // still run. The returned promise (run) still surfaces nothing because
    // #processOne catches internally.
    this.#tail = run.catch(() => {});
    return run;
  }

  async #processOne(frame) {
    let decrypted = null;
    try {
      decrypted = await this.#peerLinkProtocol.processDeposit(frame);
    } catch (err) {
      this.#logger.error("[InboundDepositPipeline] peer-link decrypt/handle failed: "
        + (err && err.message ? err.message : err));
    }
    if (decrypted && decrypted.userMessage) {
      try {
        await this.#events.applyUserMessage(decrypted.userMessage);
      } catch (err) {
        this.#logger.error("[InboundDepositPipeline] user-message apply failed: "
          + (err && err.message ? err.message : err));
      }
    }
    try {
      await this.#events.processDeposit(frame);
    } catch (err) {
      this.#logger.error("[InboundDepositPipeline] plaintext deposit apply failed: "
        + (err && err.message ? err.message : err));
    }
  }
}
