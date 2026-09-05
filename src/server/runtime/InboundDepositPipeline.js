import { runtimeEnvFlag } from "./runtimeEnvFlag.js";
import { depositIdentity } from "./depositIdentity.js";

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
  /** sealedDigest -> { attempts, exhausted }: per-runtime retry bound for durable delivery work. Never a reason to delete. */
  #durableRetryFailures = new Map();

  // Composite mailbox/event keys only; source plaintext stays in the outbox.
  // Parking is per-runtime. Restart permits another attempt even when the
  // persisted failure count already exceeds the bound.
  #parkedOutboxEntries = new Set();

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
  #sweepIntervalMs;
  #sweepTimer;

  constructor({ peerLinkProtocol, events, processedLog = null, outbox = null, logger = console, maxPending = 256, maxRetainAttempts = 12, sweepIntervalMs = 10_000 } = {}) {
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
    this.#sweepIntervalMs = Number.isInteger(sweepIntervalMs) && sweepIntervalMs > 0 ? sweepIntervalMs : 10_000;
    this.#sweepTimer = null;
  }

  /**
   * Start the periodic retry sweep. Re-drains BUFFERED deposits (those that could
   * not be decrypted on arrival — e.g. a reply that beat its reverse-direction
   * session) even when NO further deposit arrives to trigger the event-driven
   * re-drain. This is NOT busy-waiting: the tick is a cheap no-op whenever the
   * buffer is empty (the common case), and each real re-drain still counts against
   * #maxRetainAttempts so a poison frame is bounded. The timer is unref'd so it
   * never keeps the process alive.
   */
  start() {
    if (this.#sweepTimer) return;
    this.#sweepTimer = setInterval(() => this.#sweep(), this.#sweepIntervalMs);
    if (this.#sweepTimer && typeof this.#sweepTimer.unref === "function") this.#sweepTimer.unref();
  }

  stop() {
    if (this.#sweepTimer) {
      clearInterval(this.#sweepTimer);
      this.#sweepTimer = null;
    }
  }

  // One sweep tick: if anything is buffered and no re-drain is in flight, chain a
  // re-drain onto the serialized queue (behind any in-flight submit) so it never
  // races the live path. No-op when the buffer is empty.
  #sweep() {
    if (this.#pending.size === 0 || this.#redraining) return;
    this.#tail = this.#tail.then(() => {
      if (this.#pending.size === 0 || this.#redraining) return undefined;
      return this.#redrainPending();
    }).then(() => undefined, () => undefined);
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
    return depositIdentity(frame);
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
    if (runtimeEnvFlag("REZ_PEERLINK_TRACE")) {
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
          if (runtimeEnvFlag("REZ_PEERLINK_TRACE")) {
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
    const hasDeliveryAck = Boolean(status && status.deliveryAck);
    const hasDurableWork = Boolean(status && status.deliveryWork);

    // Audit P1.1 — durable post-decrypt staging. The double ratchet has now
    // advanced past this ciphertext, so it can never be re-decrypted. STAGE the
    // decrypted payload durably BEFORE reporting it ack-safe, so an application
    // failure can be retried from the outbox instead of losing the message when
    // the cursor prunes the ciphertext.
    let staged = true;
    if (hasUserMessage && this.#outbox && !hasDurableWork) {
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
    let ackApplied = false;
    if (hasDeliveryAck) {
      try {
        if (typeof this.#events.applyDeliveryAck !== "function") {
          throw new Error("events.applyDeliveryAck is unavailable");
        }
        await this.#events.applyDeliveryAck(status.deliveryAck);
        if (typeof this.#peerLinkProtocol.noteDeliveryAckApplied === "function") {
          this.#peerLinkProtocol.noteDeliveryAckApplied(status.deliveryAck.senderAccountId);
        }
        ackApplied = true;
      } catch (err) {
        applied = false;
        this.#logger.error("[InboundDepositPipeline] delivery-ack apply failed: "
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
    const durableUserMessage = hasDurableWork || staged || userApplied;
    if (hasUserMessage && this.#outbox && !hasDurableWork && staged) {
      // Reconcile the staged copy with the apply outcome: drop it once applied,
      // else count the failure so the retry pass can poison-bound it.
      if (userApplied) {
        await this.#markOutboxApplied(mailboxId, dedupId);
      } else {
        await this.#recordOutboxFailure(mailboxId, dedupId);
      }
    }

    if (hasDurableWork) {
      const effectApplied = status.deliveryIgnored === true
        || (hasUserMessage && userApplied)
        || (hasDeliveryAck && ackApplied);
      if (effectApplied && typeof this.#peerLinkProtocol.markDeliveryWorkApplied === "function") {
        try {
          await this.#peerLinkProtocol.markDeliveryWorkApplied(status.deliveryWork.sealedDigest);
        } catch (err) {
          this.#logger.error("[InboundDepositPipeline] durable delivery markApplied failed: "
            + (err && err.message ? err.message : err));
        }
      }
    }

    // Mark processed (dedup the one non-idempotent step, re-decrypt) only once the
    // deposit is durably recoverable — never while a stage+apply double-failure
    // means it is not. Marked AFTER apply so the dedup reflects the real outcome
    // (the submit queue serializes, so there is no in-flight redelivery to race).
    const shouldMark = decryptOk && (hasDurableWork || !hasUserMessage || durableUserMessage);
    if (this.#processedLog && dedupId && shouldMark) {
      try {
        await this.#processedLog.mark(mailboxId, dedupId);
      } catch (err) {
        this.#logger.error("[InboundDepositPipeline] processed-log mark failed: "
          + (err && err.message ? err.message : err));
      }
    }

    const durable = hasDurableWork ? true : (hasUserMessage ? durableUserMessage : consumed);
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
   * that exceed the retry bound are retained and parked for this runtime. A
   * transient notice is not a durable disposition and cannot authorize deletion.
   * Restart allows another attempt; clearing a fault alone does not unpark work.
   * Returns { applied: string[], quarantined: [] }; the latter remains for caller
   * compatibility, but neither retained-work path emits a dropped-message notice.
   */
  retryApplyOutbox(mailboxId, opts = {}) {
    const run = this.#tail.then(() => this.#retryApplyOutbox(mailboxId, opts));
    this.#tail = run.catch(() => {});
    return run;
  }

  async #retryApplyOutbox(mailboxId, { maxAttempts = 0, maxAgeMs = 0, minAttemptsForAge = 0, nowMs = Date.now() } = {}) {
    const applied = [];
    const quarantined = [];
    if (typeof this.#peerLinkProtocol.listPendingDeliveryWork === "function"
        && typeof this.#peerLinkProtocol.classifyDeliveryWork === "function") {
      let durablePending = [];
      try {
        durablePending = await this.#peerLinkProtocol.listPendingDeliveryWork();
      } catch (err) {
        this.#logger.error("[InboundDepositPipeline] durable delivery listPending failed: "
          + (err && err.message ? err.message : err));
      }
      for (const work of durablePending) {
        const digest = work && typeof work.sealedDigest === "string" ? work.sealedDigest : "";
        const priorFailure = digest ? this.#durableRetryFailures.get(digest) : null;
        if (priorFailure && priorFailure.exhausted === true) {
          // Over the bound for THIS runtime. The work is deliberately RETAINED
          // (see the catch below); we just stop spending CPU on it until the
          // next restart resets the in-memory counter.
          continue;
        }
        try {
          const classified = this.#peerLinkProtocol.classifyDeliveryWork(work, { mailboxId });
          if (classified.userMessage) {
            await this.#events.applyUserMessage(classified.userMessage);
          } else if (classified.deliveryAck) {
            if (typeof this.#events.applyDeliveryAck !== "function") {
              throw new Error("events.applyDeliveryAck is unavailable");
            }
            await this.#events.applyDeliveryAck(classified.deliveryAck);
            if (typeof this.#peerLinkProtocol.noteDeliveryAckApplied === "function") {
              this.#peerLinkProtocol.noteDeliveryAckApplied(classified.deliveryAck.senderAccountId);
            }
          }
          await this.#peerLinkProtocol.markDeliveryWorkApplied(work.sealedDigest);
          if (digest) this.#durableRetryFailures.delete(digest);
          applied.push("delivery:" + work.sealedDigest);
        } catch (err) {
          this.#logger.error("[InboundDepositPipeline] durable delivery retry failed for "
            + (digest || "<unknown>") + ": "
            + (err && err.message ? err.message : err));
          // Bound the RETRIES, not the work. Without a bound a permanently-failing
          // record — malformed payload, an owner mismatch after a profile
          // restore, a thread that can never become ready — is re-classified and
          // re-applied on EVERY pass, forever. This deliberately does NOT mirror
          // the apply-outbox loop below: that loop deletes on its bound, and
          // deleting is the wrong answer here (see the RETAIN comment further
          // down for why). Nothing is pushed to `quarantined` from this path on
          // purpose — no drop happened, so a drop notice would be a lie.
          if (!digest) continue;
          const prev = this.#durableRetryFailures.get(digest);
          const attempts = (prev && Number.isFinite(prev.attempts) ? prev.attempts : 0) + 1;
          this.#durableRetryFailures.set(digest, { attempts });
          // Age runs from the work record's PERSISTED createdAtMs, so the bound
          // survives restarts. Note this is NOT a lifetime cap: the work is never
          // deleted, so it lives until a durable disposition exists to surface it
          // (rezprotocol/rez-sdk#3). Attempts are in-memory and reset on restart,
          // which is deliberate: a device that keeps restarting fails the floor
          // and therefore never parks on wall-clock alone. That errs toward
          // retrying an undelivered message, never toward abandoning one — the
          // M5 rule (plans/MOBILE_LIFECYCLE_ADAPTER_PLAN.md). The cost is the
          // mirror image: parked work is not retried until restart even if the
          // underlying fault clears. Both are accepted for the interim.
          const createdAtMs = Number(work && work.createdAtMs);
          const ageMs = (Number.isFinite(createdAtMs) && Number.isFinite(nowMs))
            ? Math.max(0, nowMs - createdAtMs)
            : 0;
          const overAttempts = Number.isFinite(maxAttempts) && maxAttempts > 0 && attempts >= maxAttempts;
          const attemptsFloorMet = !(Number.isFinite(minAttemptsForAge) && minAttemptsForAge > 0)
            || attempts >= minAttemptsForAge;
          const overAge = Number.isFinite(maxAgeMs) && maxAgeMs > 0 && ageMs >= maxAgeMs && attemptsFloorMet;
          if (!overAttempts && !overAge) continue;
          // RETAIN, do not drop. An earlier revision called markDeliveryWorkApplied
          // here and then pushed a `quarantined` entry — but that entry is a
          // transient array that becomes a bus event and a session-local UI
          // notice, not a durable record. Deleting the plaintext first and
          // notifying second is silent loss whenever no UI is listening or the
          // process dies between the two lines: replay state reads `applied`,
          // the next drain finds no pending work and no notice, and the
          // message is simply gone. The older outbox path had the same flaw;
          // both paths now retain work instead of trusting a transient notice.
          //
          // Interim (review, 2026-08-30): keep the work pending and stop retrying
          // it for this runtime. Nothing is deleted, so a future durable
          // disposition can still surface it. The real fix — persist an
          // idempotent quarantine/notice record BEFORE finalizing the work, and
          // replay notices on reconnect — belongs to the DT-302 design
          // (rezprotocol/rez-sdk#3), which owns the durable work store.
          this.#durableRetryFailures.set(digest, { attempts, exhausted: true });
          this.#logger.error("[InboundDepositPipeline] durable delivery work " + digest
            + " exceeded its retry bound (" + (overAge ? "age" : "attempts") + ", attempts=" + attempts
            + ", ageMs=" + ageMs + "); RETAINED and parked for this runtime, not dropped");
        }
      }
    }
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
      const retryKey = JSON.stringify([mailboxId, dedupId]);
      if (this.#parkedOutboxEntries.has(retryKey)) continue;
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
        // M5 (mobile plan §7): the age bound counts wall-clock — which on a
        // suspended device elapses with ZERO retries run. The attempts floor
        // makes wall-clock alone unable to park a barely-tried entry. Neither
        // this age bound nor the attempt bound authorizes deletion.
        const attemptsFloorMet = !(Number.isFinite(minAttemptsForAge) && minAttemptsForAge > 0)
          || res.attempts >= minAttemptsForAge;
        const overAge = Number.isFinite(maxAgeMs) && maxAgeMs > 0 && ageMs >= maxAgeMs && attemptsFloorMet;
        if (overAttempts || overAge) {
          // Retain the only recoverable plaintext. Drop-then-notify loses the
          // message when no UI is listening or the process dies before the event.
          // A durable disposition/replay contract must precede finalization
          // (rezprotocol/rez-sdk#3); until then only successful apply may remove it.
          this.#parkedOutboxEntries.add(retryKey);
          this.#logger.error("[InboundDepositPipeline] apply-outbox entry " + dedupId
            + " in " + mailboxId + " exceeded its retry bound ("
            + (overAge ? "age" : "attempts") + ", attempts=" + res.attempts
            + ", ageMs=" + ageMs + "); RETAINED and parked for this runtime, not dropped");
        }
      }
    }
    return { applied, quarantined };
  }
}
