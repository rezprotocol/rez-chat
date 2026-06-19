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
 *
 * Self-healing retry buffer (the offline push-before-handshake fix): a deposit
 * that can't be consumed yet (no session — e.g. a group message PUSH-delivered
 * before its establishing handshake) is retained IN MEMORY with its ciphertext
 * and re-fed through the pipeline as soon as a LATER deposit is consumed (a
 * consumed handshake is exactly what unblocks it). This does not depend on the
 * relay/node re-offering the deposit to catch-up — once delivered over the wire,
 * the chat-server holds the bytes itself. Without this, a message that lost the
 * delivery race to its own handshake was stranded ~50% of the time: the relay's
 * transient buffer drops a delivered deposit (ack-after-deliver, the v0.4.3 DoS
 * fix) and catch-up's mailbox.list then returns items=0. See memory
 * project_offline_push_before_handshake_race. The buffer is bounded by entry
 * count and per-entry re-attempt cap (a poison frame is dropped, never wedges).
 */
export class InboundDepositPipeline {
  #peerLinkProtocol;
  #events;
  #processedLog;
  #outbox;
  #logger;
  #tail;
  #pending;
  #redraining;
  #maxPending;
  #maxRetainAttempts;

  constructor({ peerLinkProtocol, events, processedLog = null, outbox = null, logger = console, maxPending = 256, maxRetainAttempts = 12 } = {}) {
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
    // Optional durable post-decrypt apply-outbox (audit P1.1). When present, a
    // decrypted user message is STAGED here before it can be acked, so an
    // application failure never lets the cursor prune the only ciphertext.
    this.#outbox = outbox && typeof outbox.stage === "function" && typeof outbox.markApplied === "function"
      ? outbox
      : null;
    this.#logger = logger;
    this.#tail = Promise.resolve();
    // (mailboxId:eventId) -> { frame, attempts } for deposits received but not
    // yet consumable (no session). Re-fed when a later deposit is consumed.
    this.#pending = new Map();
    this.#redraining = false;
    this.#maxPending = Number.isInteger(maxPending) && maxPending > 0 ? maxPending : 256;
    this.#maxRetainAttempts = Number.isInteger(maxRetainAttempts) && maxRetainAttempts > 0 ? maxRetainAttempts : 12;
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
   * @param {{ body?: object, mailboxId?: string, eventId?: string, seq?: number, ciphertextB64?: string }} frame
   * @returns {Promise<{ consumed: boolean, decryptOk: boolean, alreadyProcessed: boolean, applied: boolean }>}
   */
  submit(frame) {
    const run = this.#tail.then(() => this.#processAndHeal(frame));
    // Keep the chain alive even if this deposit throws — the next submit must
    // still run. `run` resolves with the status object (#processOne catches
    // internally); the .catch here is only a backstop for the tail chain.
    this.#tail = run.catch(() => {});
    return run;
  }

  // Process one deposit, update the retry buffer, and — if this deposit was a
  // fresh consume (e.g. a handshake that just established a session) — re-drain
  // any deposits that were waiting on it. Runs serialized on the submit queue.
  async #processAndHeal(frame) {
    const result = await this.#processOne(frame);
    this.#updatePending(frame, result);
    if (result.consumed && !result.alreadyProcessed && this.#pending.size > 0 && !this.#redraining) {
      await this.#redrainPending();
    }
    return result;
  }

  #frameIds(frame) {
    const body = frame && frame.body && typeof frame.body === "object" ? frame.body : (frame || {});
    const mailboxId = typeof body.mailboxId === "string" ? body.mailboxId : "";
    const eventId = typeof body.eventId === "string" ? body.eventId : "";
    // Durable nodes (S2) stamp a per-inbox monotonic `seq` on every deposit,
    // carried on the live EVT and on each catch-up list item. When present it is
    // the home-stable dedup identity: the relay `eventId` is home-local AND absent
    // on durable catch-up items (which carry only { seq, ciphertextB64 }), so the
    // one non-idempotent step (re-decrypt) must be guarded on `seq` instead. dedupId
    // selects seq in durable mode, eventId otherwise — identical guarding on both the
    // live-push and reconnect-drain paths, with zero change for legacy/fs frames.
    const seq = Number.isInteger(body.seq) && body.seq >= 0 ? body.seq : null;
    const dedupId = seq != null ? "seq:" + seq : eventId;
    return { mailboxId, eventId, seq, dedupId };
  }

  #frameCiphertext(frame) {
    const body = frame && frame.body && typeof frame.body === "object" ? frame.body : (frame || {});
    return typeof body.ciphertextB64 === "string" && body.ciphertextB64.length > 0 ? body.ciphertextB64 : "";
  }

  // Add/remove a deposit from the retry buffer based on its processing result.
  // Only deposits carrying ciphertext (re-feedable on a later drain) are
  // retained; a consumed/dedup deposit is dropped. Bounded by #maxPending.
  #updatePending(frame, result) {
    const { mailboxId, dedupId } = this.#frameIds(frame);
    if (!dedupId) return;
    const key = mailboxId + ":" + dedupId;
    if (result && (result.consumed || result.alreadyProcessed)) {
      this.#pending.delete(key);
      return;
    }
    const ciphertextB64 = this.#frameCiphertext(frame);
    if (!ciphertextB64) return; // nothing to re-feed (plaintext deposits self-apply)
    const existing = this.#pending.get(key);
    if (existing) return; // already retained; attempts advance only via re-drain
    if (process.env.REZ_PEERLINK_TRACE === "1") {
      this.#logger.log("[PLTRACE] pipeline RETAIN evt=" + dedupId + " (pending=" + (this.#pending.size + 1) + ")");
    }
    if (this.#pending.size >= this.#maxPending) {
      // Bound the buffer — drop the oldest retained deposit (insertion order).
      const oldestKey = this.#pending.keys().next().value;
      if (oldestKey) this.#pending.delete(oldestKey);
    }
    this.#pending.set(key, { frame, attempts: 0 });
  }

  // Re-feed every retained deposit through #processOne. A consume can unblock
  // others (a handshake unblocks the messages that followed it), so loop until a
  // full pass makes no progress. A deposit that repeatedly fails is dropped after
  // #maxRetainAttempts so a poison frame can never wedge the buffer.
  async #redrainPending() {
    this.#redraining = true;
    try {
      let progress = true;
      while (progress) {
        progress = false;
        for (const [key, entry] of [...this.#pending.entries()]) {
          let r = null;
          try {
            r = await this.#processOne(entry.frame);
          } catch (err) {
            this.#logger.error("[InboundDepositPipeline] pending re-drain failed: "
              + (err && err.message ? err.message : err));
            r = null;
          }
          if (process.env.REZ_PEERLINK_TRACE === "1") {
            this.#logger.log("[PLTRACE] pipeline REDRAIN evt=" + key + " consumed=" + (r && r.consumed ? 1 : 0) + " already=" + (r && r.alreadyProcessed ? 1 : 0));
          }
          if (r && (r.consumed || r.alreadyProcessed)) {
            this.#pending.delete(key);
            progress = true;
          } else {
            entry.attempts += 1;
            if (entry.attempts >= this.#maxRetainAttempts) {
              this.#pending.delete(key);
            }
          }
        }
      }
    } finally {
      this.#redraining = false;
    }
  }

  async #processOne(frame) {
    const { mailboxId, dedupId } = this.#frameIds(frame);
    // Skip a deposit already decrypted + consumed earlier (typically via the
    // live push path) and now re-fetched by the catch-up drain. Re-decrypting it
    // would fail the (already-advanced) double ratchet and could swallow the
    // genuinely-new deposit that follows. Downstream applies are canonical-key
    // idempotent; the decrypt is the one non-idempotent step, so dedup here.
    if (this.#processedLog && dedupId) {
      let already = false;
      try {
        already = await this.#processedLog.has(mailboxId, dedupId);
      } catch (err) {
        this.#logger.error("[InboundDepositPipeline] processed-log lookup failed: "
          + (err && err.message ? err.message : err));
      }
      // Already decrypted + consumed earlier (live push). The buffer copy is
      // redundant — never re-decrypt. durable:true because marking only happens
      // AFTER a successful durable stage (below), so an already-processed deposit
      // was provably staged (or applied). Any staged-but-unapplied payload is
      // re-applied by the retryApplyOutbox pass, not here.
      if (already) return { consumed: true, decryptOk: false, alreadyProcessed: true, applied: false, durable: true };
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
    const hasUserMessage = Boolean(status && status.userMessage);

    // Audit P1.1 — durable post-decrypt staging. The double ratchet has now
    // advanced past this ciphertext, so it can never be re-decrypted. STAGE the
    // decrypted payload durably BEFORE reporting it ack-safe, so an application
    // failure can be retried from the outbox instead of losing the message when
    // the cursor prunes the ciphertext.
    let staged = true;
    if (hasUserMessage && this.#outbox) {
      staged = false;
      try {
        await this.#outbox.stage(mailboxId, dedupId, status.userMessage);
        staged = true;
      } catch (err) {
        this.#logger.error("[InboundDepositPipeline] apply-outbox stage failed: "
          + (err && err.message ? err.message : err));
      }
    }

    // Apply the decrypted user message to the message store (the durable home).
    let applied = true;
    let userApplied = false;
    if (hasUserMessage) {
      try {
        await this.#events.applyUserMessage(status.userMessage);
        userApplied = true;
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

    // Audit P2 — STAGED-OR-APPLIED. A user message is durably recoverable iff it
    // is staged in the outbox OR it was applied to the message store; EITHER is
    // sufficient to advance the cursor. (The old `durable = staged` dropped the
    // applied-but-not-staged case: a stage failure with a successful apply left a
    // delivered message unackable — the cursor stuck, then a doomed re-decrypt
    // wrongly surfaced it as poison.) A non-message deposit (handshake/ack)
    // inherits the consume signal. Ack layers gate on `durable`, never a bare decrypt.
    const durableUserMessage = staged || userApplied;
    if (hasUserMessage && this.#outbox && staged) {
      // Reconcile the staged copy with the apply outcome: drop it once applied,
      // else count the failure so the retry pass can poison-bound it.
      if (userApplied) {
        await this.#markOutboxApplied(mailboxId, dedupId);
      } else {
        await this.#recordOutboxFailure(mailboxId, dedupId);
      }
    }

    // Mark processed (dedup the one non-idempotent step, re-decrypt) only once the
    // deposit is durably recoverable — never while a stage+apply double-failure
    // means it is not. Marked AFTER apply so the dedup reflects the real outcome
    // (the submit queue serializes, so there is no in-flight redelivery to race).
    const shouldMark = decryptOk && (!hasUserMessage || durableUserMessage);
    if (this.#processedLog && dedupId && shouldMark) {
      try {
        await this.#processedLog.mark(mailboxId, dedupId);
      } catch (err) {
        this.#logger.error("[InboundDepositPipeline] processed-log mark failed: "
          + (err && err.message ? err.message : err));
      }
    }

    const durable = hasUserMessage ? durableUserMessage : consumed;
    return { consumed, decryptOk, alreadyProcessed: false, applied, durable };
  }

  async #markOutboxApplied(mailboxId, dedupId) {
    try {
      await this.#outbox.markApplied(mailboxId, dedupId);
    } catch (err) {
      this.#logger.error("[InboundDepositPipeline] apply-outbox markApplied failed: "
        + (err && err.message ? err.message : err));
    }
  }

  async #recordOutboxFailure(mailboxId, dedupId, nowMs) {
    try {
      return await this.#outbox.recordApplyFailure(mailboxId, dedupId, { nowMs: Number.isFinite(nowMs) ? nowMs : Date.now() });
    } catch (err) {
      this.#logger.error("[InboundDepositPipeline] apply-outbox recordApplyFailure failed: "
        + (err && err.message ? err.message : err));
      return { attempts: 0, firstStagedAtMs: null };
    }
  }

  /**
   * Retry application of staged-but-unapplied outbox entries for a mailbox (the
   * cursor may already have advanced past them — the plaintext lives in the
   * outbox, never re-decrypted). Serialized on the same submit queue. Entries
   * that exceed the poison bound are dropped and RETURNED so the caller can
   * surface a visible System notice. Returns { applied: string[], quarantined:
   * Array<{ dedupId, attempts, ageMs, reason }> }.
   */
  retryApplyOutbox(mailboxId, opts = {}) {
    const run = this.#tail.then(() => this.#retryApplyOutbox(mailboxId, opts));
    this.#tail = run.catch(() => {});
    return run;
  }

  async #retryApplyOutbox(mailboxId, { maxAttempts = 0, maxAgeMs = 0, nowMs = Date.now() } = {}) {
    const applied = [];
    const quarantined = [];
    if (!this.#outbox || typeof this.#outbox.listPending !== "function") {
      return { applied, quarantined };
    }
    let pending = [];
    try {
      pending = await this.#outbox.listPending(mailboxId);
    } catch (err) {
      this.#logger.error("[InboundDepositPipeline] apply-outbox listPending failed: "
        + (err && err.message ? err.message : err));
      return { applied, quarantined };
    }
    for (const entry of pending) {
      const dedupId = entry && typeof entry.dedupId === "string" ? entry.dedupId : "";
      if (!dedupId) continue;
      try {
        await this.#events.applyUserMessage(entry.userMessage);
        await this.#markOutboxApplied(mailboxId, dedupId);
        applied.push(dedupId);
      } catch (err) {
        this.#logger.error("[InboundDepositPipeline] apply-outbox retry failed for " + dedupId + ": "
          + (err && err.message ? err.message : err));
        const res = await this.#recordOutboxFailure(mailboxId, dedupId, nowMs);
        const ageMs = (Number.isFinite(res.firstStagedAtMs) && Number.isFinite(nowMs))
          ? Math.max(0, nowMs - res.firstStagedAtMs)
          : 0;
        const overAttempts = Number.isFinite(maxAttempts) && maxAttempts > 0 && res.attempts >= maxAttempts;
        const overAge = Number.isFinite(maxAgeMs) && maxAgeMs > 0 && ageMs >= maxAgeMs;
        if (overAttempts || overAge) {
          // Poison apply: stop retrying forever. Drop from the outbox and report
          // it so the drain surfaces a visible System notice (no silent loss).
          await this.#markOutboxApplied(mailboxId, dedupId);
          quarantined.push({ dedupId, attempts: res.attempts, ageMs, reason: overAge ? "age" : "attempts" });
        }
      }
    }
    return { applied, quarantined };
  }
}
