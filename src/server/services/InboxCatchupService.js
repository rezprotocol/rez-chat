import { BaseServerService } from "../base/BaseServerService.js";
import { MailboxDepositQuarantinedEvent } from "../../records/index.js";
import { nodeAdvertisesDurableInbox } from "../inbox/durableMode.js";

const DEFAULT_PAGE_LIMIT = 50;
// D1: after this many failed decrypts across drains, a deposit is treated as
// poison and quarantined (acked + dropped) so it can't be retried forever.
const DEFAULT_MAX_DECRYPT_ATTEMPTS = 8;
// D1 (age bound): a deposit still undecryptable this long after we FIRST failed
// on it is quarantined regardless of attempt count. The attempt bound alone is
// reconnect-gated (one attempt per drain), so a permanently-undecryptable deposit
// on a long-lived connection could be re-listed and re-drained for a very long
// time. The age bound caps zombie lifetime by wall-clock. 30 min is far longer
// than any legitimate transient (ordering races / rehandshake recovery resolve in
// seconds-to-minutes) yet bounded — measured from first-failure so genuine
// recovery of an old offline message still gets the full window.
const DEFAULT_MAX_QUARANTINE_AGE_MS = 30 * 60 * 1000;
// REZ-11: a deposit that has failed to decrypt MANY times is almost certainly
// poison being rescanned on every reconnect (O(buffer) crypto/IO per reconnect on
// a flaky link). Once it crosses this attempt threshold, hold it under a short
// backoff so rapid reconnects stop re-decrypting the whole floor. Crucially the
// threshold leaves the FIRST few retries unthrottled, so a genuine out-of-order
// message (whose handshake/dependency just arrived) still recovers immediately —
// only the persistent floor is throttled. The age/attempt quarantine bounds still
// apply on the attempts that run, so nothing is ever permanently stranded.
const DECRYPT_RETRY_BACKOFF_MS = 15 * 1000;
const DECRYPT_BACKOFF_AFTER_ATTEMPTS = 3;

/**
 * On chat-server start (and on every SDK transport reconnect), drain any mailbox
 * deposits that landed in the relay's inbox store while this owner had no active
 * WS session — and any that the live push path could not decrypt yet.
 *
 * Consume model (ack-and-delete, mirrors the ratchet's own commit-on-success):
 *   - List the inbox FROM THE START (no persisted high-water cursor) and feed
 *     each deposit through the serialized InboundDepositPipeline.
 *   - On success (decrypted, or a dedup hit already consumed via live push) ACK
 *     it — `sdk.mailbox.ack` removes it from the relay buffer, so it is gone for
 *     good and the buffer drains to empty.
 *   - On a failed decrypt LEAVE it buffered. The decrypt did not commit the
 *     ratchet, so a later pass (e.g. once an out-of-order handshake ahead of it
 *     has been applied) can decrypt it cleanly. A genuinely-poison deposit is
 *     quarantined (D1) by whichever bound hits first: a failed-attempt counter
 *     (fast for a flood) or an age bound measured from first failure (caps a
 *     zombie's lifetime by wall-clock — the attempt bound only advances once per
 *     drain, so on a long-lived connection that rarely reconnects it alone could
 *     let an undecryptable deposit be re-listed for a very long time).
 *
 * This replaces the old monotonic cursor, which advanced past a deposit even when
 * the pipeline swallowed its decrypt failure — permanently stranding it in the
 * buffer (never re-fetched, never acked). The pipeline's ProcessedDepositLog
 * still guards the one non-idempotent step (re-decrypt) against double delivery.
 */
export class InboxCatchupService extends BaseServerService {
  #inboxClaimant;
  #pageLimit;
  #maxDecryptAttempts;
  #draining;
  #pending;
  #offReconnect;
  #pipeline;
  #processedLog;
  #maxQuarantineAgeMs;
  #clock;
  #periodicDrainMs;
  #periodicTimer;
  // REZ-11: eventId -> earliest ms at which a failed deposit may be re-attempted.
  // In-memory (per session); bounded by the mailbox buffer cap and pruned on ack.
  #decryptBackoffUntilMsByEvent = new Map();

  constructor({ bus, inboxClaimant, inboundPipeline, processedLog = null, pageLimit = DEFAULT_PAGE_LIMIT, maxDecryptAttempts = DEFAULT_MAX_DECRYPT_ATTEMPTS, maxQuarantineAgeMs = DEFAULT_MAX_QUARANTINE_AGE_MS, periodicDrainMs = 30_000, clock = () => Date.now(), logger = console } = {}) {
    super({ bus, logger });
    if (!inboxClaimant) {
      throw new Error("InboxCatchupService requires inboxClaimant");
    }
    if (!inboundPipeline || typeof inboundPipeline.submit !== "function") {
      throw new Error("InboxCatchupService requires inboundPipeline.submit");
    }
    this.#inboxClaimant = inboxClaimant;
    this.#pipeline = inboundPipeline;
    // Optional dedup + attempt-counter store, shared with the pipeline. Used here
    // to bound poison retries and to prune markers when a deposit is acked.
    this.#processedLog = processedLog;
    this.#pageLimit = Number.isInteger(pageLimit) && pageLimit > 0 ? pageLimit : DEFAULT_PAGE_LIMIT;
    this.#maxDecryptAttempts = Number.isInteger(maxDecryptAttempts) && maxDecryptAttempts > 0
      ? maxDecryptAttempts
      : DEFAULT_MAX_DECRYPT_ATTEMPTS;
    this.#maxQuarantineAgeMs = Number.isFinite(maxQuarantineAgeMs) && maxQuarantineAgeMs > 0
      ? Number(maxQuarantineAgeMs)
      : DEFAULT_MAX_QUARANTINE_AGE_MS;
    this.#clock = typeof clock === "function" ? clock : () => Date.now();
    this.#periodicDrainMs = Number.isFinite(periodicDrainMs) && periodicDrainMs > 0 ? Number(periodicDrainMs) : 0;
    this.#periodicTimer = null;
    this.#draining = false;
    this.#pending = false;
    this.#offReconnect = null;
  }

  async start() {
    const sdk = this.bus.runtime && this.bus.runtime.sdk ? this.bus.runtime.sdk : null;
    if (!sdk || !sdk.connectivity || typeof sdk.connectivity.onReconnected !== "function") {
      throw new Error("InboxCatchupService requires sdk.connectivity.onReconnected");
    }
    this.#offReconnect = sdk.connectivity.onReconnected(() => {
      this.requestDrain().catch((err) => {
        this.logger.error("[InboxCatchupService] reconnect drain failed: " + (err && err.message ? err.message : err));
      });
    });
    // Periodic safety-net drain: the live push (MailboxPushBridge) is the primary,
    // instant delivery path, but a push CAN be missed (a race, or no cross-node
    // Redis liveness), leaving a deposit persisted in the durable home yet never fed
    // to the pipeline until the next reconnect. A low-frequency re-drain re-fetches
    // any such deposit from the cursor (cheap when nothing is new; coalesced with
    // in-flight/reconnect drains) so a quiet inbox never strands a delivered message.
    if (this.#periodicDrainMs > 0) {
      this.#periodicTimer = setInterval(() => {
        this.requestDrain().catch((err) => {
          this.logger.error("[InboxCatchupService] periodic drain failed: " + (err && err.message ? err.message : err));
        });
      }, this.#periodicDrainMs);
      if (this.#periodicTimer && typeof this.#periodicTimer.unref === "function") this.#periodicTimer.unref();
    }
    await this.requestDrain();
  }

  async stop() {
    if (this.#periodicTimer) {
      clearInterval(this.#periodicTimer);
      this.#periodicTimer = null;
    }
    if (typeof this.#offReconnect === "function") {
      try {
        this.#offReconnect();
      } catch (err) {
        this.logger.error("[InboxCatchupService] reconnect unsubscribe failed: " + (err && err.message ? err.message : err));
      }
      this.#offReconnect = null;
    }
    await super.stop();
  }

  /**
   * Coalesce concurrent drain requests: if a drain is already in flight,
   * mark pending and let the in-flight loop run one more pass before
   * resolving. Prevents two reconnects (or start+reconnect) from
   * fan-out-listing in parallel.
   */
  async requestDrain() {
    if (this.#draining) {
      this.#pending = true;
      return;
    }
    this.#draining = true;
    try {
      do {
        this.#pending = false;
        await this.#drainOnce();
      } while (this.#pending);
    } finally {
      this.#draining = false;
    }
    // Readiness signal (a true notification — emit is correct here): the inbox
    // has been drained — every decryptable deposit applied + acked, the rest left
    // for a bounded retry. Emitted under the bare bridge spec key so the transport
    // forwards it to the UI as `runtime.event.inbox.caughtup`; the UI gates "show
    // real state" on it so login never asserts the stale pre-catch-up snapshot.
    this._emit("inbox.caughtup", { mailboxId: this.#inboxClaimant.inboxId });
  }

  async #drainOnce() {
    const sdk = this.bus.runtime && this.bus.runtime.sdk ? this.bus.runtime.sdk : null;
    if (!sdk || !sdk.mailbox) {
      throw new Error("InboxCatchupService requires sdk.mailbox");
    }
    const mailboxId = this.#inboxClaimant.inboxId;
    if (typeof mailboxId !== "string" || mailboxId.length === 0) {
      throw new Error("InboxCatchupService: inboxClaimant.inboxId is not set");
    }

    // Audit P1.1 (both modes) — before draining new deposits, retry any
    // decrypted-but-unapplied payloads staged in the apply-outbox. This runs
    // for the legacy/fs path too: a message acked as `durable` (staged) but not
    // yet applied has the outbox as its ONLY recovery path (the buffer copy may
    // be gone / un-re-decryptable), and poison entries surface as System notices
    // rather than vanishing. Previously this ran only in the durable branch, so
    // a legacy-path staged-but-unapplied entry was stranded forever.
    await this.#retryApplyOutbox(mailboxId);

    // D2 dual-mode gate: a durable-capable node (S2) uses the server-held cursor
    // model (inline { seq, ciphertextB64 } + mailbox.cursorAck); a legacy/fs node
    // keeps the list/fetch/ack delete model untouched. This single check is what
    // protects the shipped desktop + DO-relay path from any S2 behavior change.
    if (nodeAdvertisesDurableInbox(sdk)) {
      await this.#drainDurable(sdk, mailboxId);
      return;
    }

    if (typeof sdk.mailbox.list !== "function" || typeof sdk.mailbox.fetch !== "function" || typeof sdk.mailbox.ack !== "function") {
      throw new Error("InboxCatchupService requires sdk.mailbox.list/fetch/ack");
    }

    // In-memory page cursor for THIS pass only — never persisted. It walks the
    // whole buffer once (forward, regardless of per-item outcome) so left-behind
    // failures don't re-appear within the same pass and loop forever; they are
    // retried by the NEXT drain, which starts fresh from the beginning.
    let pageCursor = null;
    while (true) {
      const page = await sdk.mailbox.list({ mailboxId, cursor: pageCursor, limit: this.#pageLimit });
      const items = page && Array.isArray(page.items) ? page.items : [];
      if (process.env.REZ_INBOX_CATCHUP_DEBUG === "1") {
        this.logger.log("[InboxCatchupService] mailbox.list mailboxId=" + mailboxId + " cursor=" + (pageCursor || "null") + " items=" + items.length + " nextCursor=" + (page && page.nextCursor ? page.nextCursor : "null"));
      }
      if (items.length === 0) return;
      for (const item of items) {
        const eventId = item && typeof item.eventId === "string" ? item.eventId : "";
        if (!eventId) continue;
        pageCursor = eventId;
        // REZ-11: a deposit that failed to decrypt very recently is left buffered
        // with a short backoff — don't re-fetch/re-decrypt it until the backoff
        // elapses, so rapid reconnects don't re-scan the whole poison floor.
        const backoffUntil = this.#decryptBackoffUntilMsByEvent.get(eventId);
        if (typeof backoffUntil === "number" && this.#clock() < backoffUntil) {
          continue;
        }
        const fetched = await sdk.mailbox.fetch({ mailboxId, eventId });
        const ciphertextB64 = fetched && typeof fetched.ciphertextB64 === "string" ? fetched.ciphertextB64 : "";
        const frame = {
          t: "evt.mailbox.deposited",
          body: { mailboxId, eventId, ciphertextB64 },
        };
        // Directive, not a notification: process this deposit to FULL COMPLETION
        // (decrypt → apply membership/message, in order) before touching the next.
        // The serialized pipeline guarantees a member.join is applied before any
        // message that depends on it.
        let result = null;
        try {
          result = await this.#pipeline.submit(frame);
        } catch (err) {
          this.logger.error("[InboxCatchupService] pipeline submit threw for " + eventId + ": " + (err && err.message ? err.message : err));
        }
        // Ack-safe ONLY when the deposit is DURABLE (audit P1.1): a decrypted user
        // message must be durably staged-or-applied before we ack-DELETE the relay
        // buffer copy (its only ciphertext) — a bare decrypt that then fails to
        // stage AND apply must leave the deposit buffered, not delete it. `durable`
        // falls back to `consumed` for non-durable pipelines/mocks that predate it.
        const durable = result && result.durable != null ? result.durable : (result && result.consumed);
        const ok = Boolean(durable || (result && result.alreadyProcessed));
        if (process.env.REZ_INBOX_CATCHUP_DEBUG === "1" || process.env.REZ_PEERLINK_TRACE === "1") {
          this.logger.log(
            "[InboxCatchupService] item evt=" + eventId + " ctLen=" + ciphertextB64.length
            + " consumed=" + (result && result.consumed ? 1 : 0)
            + " decryptOk=" + (result && result.decryptOk ? 1 : 0)
            + " already=" + (result && result.alreadyProcessed ? 1 : 0)
            + " reason=" + (result && result.reason ? result.reason : "-")
            + " -> " + (ok ? "ACK+DELETE" : "LEAVE"),
          );
        }
        if (ok) {
          await this.#ackAndForget(sdk, mailboxId, eventId);
        } else {
          await this.#handleDecryptFailure(sdk, mailboxId, eventId);
        }
      }
      const nextCursor = page && typeof page.nextCursor === "string" ? page.nextCursor : null;
      if (!nextCursor) return;
      pageCursor = nextCursor;
    }
  }

  // Durable-node catch-up (S2). mailbox.list returns inline { seq, ciphertextB64 }
  // items strictly AFTER the server-held device cursor; feed each through the
  // serialized pipeline and advance the cursor through the highest CONTIGUOUS
  // consumed seq via mailbox.cursorAck. cursorAck is a contiguous watermark (the
  // node may prune <= it), so a seq that won't decrypt yet STOPS the advance there
  // and the next drain re-lists from it. No fetch (bodies are inline), no ack-delete
  // (the home log is durable; the device cursor is the only mutation). A genuinely
  // poison seq is quarantined by cursor-skipping past it — never silently (it emits
  // a user-visible "couldn't be delivered" notice first).
  async #drainDurable(sdk, mailboxId) {
    if (typeof sdk.mailbox.list !== "function" || typeof sdk.mailbox.cursorAck !== "function") {
      throw new Error("InboxCatchupService (durable) requires sdk.mailbox.list/cursorAck");
    }
    // (The apply-outbox retry runs once per drain in #drainOnce, before this
    // mode branch — so both the durable and legacy paths get it.)
    while (true) {
      const page = await sdk.mailbox.list({ mailboxId, cursor: null, limit: this.#pageLimit });
      const items = page && Array.isArray(page.items) ? page.items : [];
      if (process.env.REZ_INBOX_CATCHUP_DEBUG === "1") {
        this.logger.log("[InboxCatchupService] durable list mailboxId=" + mailboxId + " items=" + items.length);
      }
      if (items.length === 0) return;
      let throughSeq = 0;          // highest contiguous consumed seq this batch
      const consumedSeqs = [];     // seqs whose dedup marker we may forget post-ack
      let blocked = false;
      for (const item of items) {
        const seq = this.#itemSeq(item);
        if (seq == null) {
          // A durable node always stamps an integer seq; a missing one means we
          // cannot safely cursor past this item, so HALT the pass (a stuck cursor
          // is debuggable; a silent skip would drop mail). Retries next drain.
          this.logger.error("[InboxCatchupService] durable list item missing a usable seq; halting drain pass");
          blocked = true;
          break;
        }
        // Poison backoff: a seq that recently failed is held briefly so rapid
        // reconnects don't re-decrypt the whole floor. It is a GAP — stop the
        // contiguous advance here and retry it on the next drain.
        const backoffUntil = this.#decryptBackoffUntilMsByEvent.get("seq:" + seq);
        if (typeof backoffUntil === "number" && this.#clock() < backoffUntil) {
          blocked = true;
          break;
        }
        const frame = { t: "evt.mailbox.deposited", body: { mailboxId, seq, ciphertextB64: this.#itemCiphertext(item) } };
        let result = null;
        try {
          result = await this.#pipeline.submit(frame);
        } catch (err) {
          this.logger.error("[InboxCatchupService] durable pipeline submit threw for seq=" + seq + ": " + (err && err.message ? err.message : err));
        }
        // Ack-safe ONLY when the deposit is DURABLE (audit P1.1): a user message
        // must be durably staged in the apply-outbox (not merely decrypted) before
        // the cursor advances and the home prunes its only ciphertext. `durable`
        // falls back to `consumed` for non-durable pipelines/mocks that predate it.
        const durable = result && result.durable != null ? result.durable : (result && result.consumed);
        const ok = Boolean(durable || (result && result.alreadyProcessed));
        if (ok) {
          throughSeq = seq;
          consumedSeqs.push(seq);
          continue;
        }
        // Gap: a seq we cannot consume yet. Count it; once a bound (D1) fires,
        // QUARANTINE by cursor-skipping past it (after surfacing a notice). Else
        // leave the cursor below it and retry next drain (a failed decrypt did not
        // commit the ratchet, so an ordering race can still resolve it).
        const skip = await this.#handleDurableFailure(mailboxId, seq);
        if (skip) {
          throughSeq = seq;        // accept the loss; advance past the poison seq
          continue;
        }
        blocked = true;
        break;
      }
      if (throughSeq > 0) {
        try {
          await sdk.mailbox.cursorAck({ mailboxId, throughSeq });
        } catch (err) {
          // The cursor did not advance; the next drain re-lists from the same point
          // (cursorAck is monotonic + idempotent, so the retry is safe). Keep markers.
          this.logger.error("[InboxCatchupService] cursorAck failed mailboxId=" + mailboxId + " throughSeq=" + throughSeq + ": " + (err && err.message ? err.message : err));
          return;
        }
        // The acked seqs are now behind the server cursor and can never be re-listed,
        // so their dedup markers are dead weight — forget them to keep the log bounded.
        await this.#forgetConsumedSeqs(mailboxId, consumedSeqs);
      }
      if (blocked) return;          // leave the rest for the next drain
      // else: a full batch advanced the cursor — loop and list the next window.
    }
  }

  #itemSeq(item) {
    if (!item || typeof item !== "object") return null;
    if (Number.isInteger(item.seq) && item.seq > 0) return item.seq;
    const n = Number(item.seq);
    return Number.isInteger(n) && n > 0 ? n : null;
  }

  #itemCiphertext(item) {
    return item && typeof item.ciphertextB64 === "string" ? item.ciphertextB64 : "";
  }

  async #forgetConsumedSeqs(mailboxId, consumedSeqs) {
    if (!this.#processedLog || typeof this.#processedLog.forget !== "function") return;
    for (const seq of consumedSeqs) {
      this.#decryptBackoffUntilMsByEvent.delete("seq:" + seq);
      await this.#processedLog.forget(mailboxId, "seq:" + seq).catch((err) => {
        this.logger.error("[InboxCatchupService] durable forget seq:" + seq + " failed: " + (err && err.message ? err.message : err));
      });
    }
  }

  // Seq-keyed mirror of #handleDecryptFailure for durable mode. Returns true when
  // the seq should be QUARANTINED (the caller cursor-skips past it), false to leave
  // the cursor below it and retry on the next drain.
  async #handleDurableFailure(mailboxId, seq) {
    const seqKey = "seq:" + seq;
    if (!this.#processedLog || typeof this.#processedLog.recordAttempt !== "function") {
      this.logger.warn("[InboxCatchupService] durable deposit seq=" + seq + " left buffered (no attempt store to bound retries)");
      return false;
    }
    const nowMs = this.#clock();
    let attempts = 0;
    try {
      attempts = await this.#processedLog.recordAttempt(mailboxId, seqKey, { nowMs });
    } catch (err) {
      this.logger.error("[InboxCatchupService] durable attempt-counter record failed for seq=" + seq + ": " + (err && err.message ? err.message : err));
      return false;
    }
    let firstSeenAtMs = 0;
    if (typeof this.#processedLog.firstSeenAtMs === "function") {
      try {
        firstSeenAtMs = await this.#processedLog.firstSeenAtMs(mailboxId, seqKey);
      } catch (err) {
        this.logger.error("[InboxCatchupService] durable firstSeen lookup failed for seq=" + seq + ": " + (err && err.message ? err.message : err));
        firstSeenAtMs = 0;
      }
    }
    const ageMs = firstSeenAtMs > 0 ? (nowMs - firstSeenAtMs) : 0;
    const tooManyAttempts = attempts >= this.#maxDecryptAttempts;
    const tooOld = firstSeenAtMs > 0 && ageMs >= this.#maxQuarantineAgeMs;
    if (tooManyAttempts || tooOld) {
      const reason = tooManyAttempts ? "attempts" : "age";
      this.logger.error(
        "[InboxCatchupService] quarantining (cursor-skip) undecryptable durable deposit mailboxId=" + mailboxId
        + " seq=" + seq + " after " + attempts + " attempts, ageMs=" + ageMs + " (" + reason + " bound)",
      );
      // Surface it BEFORE skipping — a dropped message must never vanish silently.
      this.#emitQuarantined({ mailboxId, seq, attempts, ageMs, reason });
      if (typeof this.#processedLog.clearAttempts === "function") {
        await this.#processedLog.clearAttempts(mailboxId, seqKey).catch((err) => {
          this.logger.error("[InboxCatchupService] durable attempt-counter clear failed: " + (err && err.message ? err.message : err));
        });
      }
      if (typeof this.#processedLog.forget === "function") {
        await this.#processedLog.forget(mailboxId, seqKey).catch((err) => {
          this.logger.error("[InboxCatchupService] durable forget failed: " + (err && err.message ? err.message : err));
        });
      }
      this.#decryptBackoffUntilMsByEvent.delete(seqKey);
      return true;
    }
    if (attempts >= DECRYPT_BACKOFF_AFTER_ATTEMPTS) {
      this.#decryptBackoffUntilMsByEvent.set(seqKey, nowMs + DECRYPT_RETRY_BACKOFF_MS);
      if (this.#decryptBackoffUntilMsByEvent.size > 16384) {
        for (const [k, until] of this.#decryptBackoffUntilMsByEvent) {
          if (nowMs >= until) this.#decryptBackoffUntilMsByEvent.delete(k);
        }
      }
    }
    return false;
  }

  // Surface a quarantined (dropped) deposit to the user — NEVER swallow it silently
  // (feedback_explicit_over_clever_no_data_suppression). We know only the mailbox,
  // the deposit identity (durable seq or legacy eventId), and how hard we tried; the
  // thread/sender/content are unknowable (the ciphertext never decrypted). The UI
  // renders it as a "couldn't be delivered" failed-message notice (System thread).
  // Drive the pipeline's apply-outbox retry, then surface any poison entries it
  // gave up on as quarantine notices (System thread). Bounds come from the same
  // poison knobs as decrypt quarantine, so the two paths behave consistently.
  async #retryApplyOutbox(mailboxId) {
    if (!this.#pipeline || typeof this.#pipeline.retryApplyOutbox !== "function") return;
    let result = null;
    try {
      result = await this.#pipeline.retryApplyOutbox(mailboxId, {
        maxAttempts: this.#maxDecryptAttempts,
        maxAgeMs: this.#maxQuarantineAgeMs,
        nowMs: this.#clock(),
      });
    } catch (err) {
      this.logger.error("[InboxCatchupService] apply-outbox retry pass failed: " + (err && err.message ? err.message : err));
      return;
    }
    const quarantined = result && Array.isArray(result.quarantined) ? result.quarantined : [];
    for (const q of quarantined) {
      const dedupId = q && typeof q.dedupId === "string" ? q.dedupId : "";
      let seq = null;
      let eventId = "";
      if (dedupId.indexOf("seq:") === 0) {
        const n = Number(dedupId.slice(4));
        if (Number.isInteger(n)) seq = n;
      } else {
        eventId = dedupId;
      }
      this.#emitQuarantined({ mailboxId, seq, eventId, attempts: q.attempts, ageMs: q.ageMs, reason: q.reason });
    }
  }

  #emitQuarantined({ mailboxId, seq = null, eventId = "", attempts = 0, ageMs = 0, reason = "attempts" }) {
    try {
      this._emit("mailbox.deposit.quarantined", new MailboxDepositQuarantinedEvent({
        mailboxId,
        seq: Number.isInteger(seq) ? seq : null,
        eventId: typeof eventId === "string" ? eventId : "",
        attempts: Number.isInteger(attempts) ? attempts : 0,
        ageMs: Number.isFinite(ageMs) ? Math.round(ageMs) : 0,
        reason: reason === "age" ? "age" : "attempts",
      }));
    } catch (err) {
      this.logger.error("[InboxCatchupService] failed to emit quarantine notice: " + (err && err.message ? err.message : err));
    }
  }

  // Remove a fully-consumed deposit from the relay buffer and prune its markers.
  async #ackAndForget(sdk, mailboxId, eventId) {
    // REZ-11: this deposit is leaving the buffer (consumed or quarantined) — drop
    // its retry-backoff marker so the map tracks only still-buffered deposits.
    this.#decryptBackoffUntilMsByEvent.delete(eventId);
    try {
      await sdk.mailbox.ack({ mailboxId, eventId });
    } catch (err) {
      // Leave it buffered; the next drain re-attempts the ack.
      this.logger.error("[InboxCatchupService] ack failed for " + eventId + ": " + (err && err.message ? err.message : err));
      return;
    }
    if (this.#processedLog) {
      if (typeof this.#processedLog.forget === "function") {
        await this.#processedLog.forget(mailboxId, eventId).catch((err) => {
          this.logger.error("[InboxCatchupService] processed-log forget failed: " + (err && err.message ? err.message : err));
        });
      }
      if (typeof this.#processedLog.clearAttempts === "function") {
        await this.#processedLog.clearAttempts(mailboxId, eventId).catch((err) => {
          this.logger.error("[InboxCatchupService] attempt-counter clear failed: " + (err && err.message ? err.message : err));
        });
      }
    }
  }

  // A deposit that could not be decrypted this pass: count the attempt and, once
  // it crosses a bound (D1), quarantine it (ack + drop) so a single poison deposit
  // can never wedge catch-up or be re-listed forever. Two bounds, whichever hits
  // first: attempt count (fast for a flood) and age since first failure (caps
  // lifetime by wall-clock — the attempt bound only advances once per drain, so on
  // a long-lived connection that drains rarely it could otherwise persist for a
  // very long time). Otherwise leave it for the next drain — a failed decrypt does
  // not commit the ratchet, so an ordering race or rehandshake recovery can still
  // resolve it within the window.
  async #handleDecryptFailure(sdk, mailboxId, eventId) {
    if (!this.#processedLog || typeof this.#processedLog.recordAttempt !== "function") {
      // No attempt store wired: leave it buffered (best effort, no quarantine).
      this.logger.warn("[InboxCatchupService] deposit " + eventId + " left buffered (no attempt store to bound retries)");
      return;
    }
    const nowMs = this.#clock();
    let attempts = 0;
    try {
      attempts = await this.#processedLog.recordAttempt(mailboxId, eventId, { nowMs });
    } catch (err) {
      this.logger.error("[InboxCatchupService] attempt-counter record failed for " + eventId + ": " + (err && err.message ? err.message : err));
      return;
    }
    let firstSeenAtMs = 0;
    if (typeof this.#processedLog.firstSeenAtMs === "function") {
      try {
        firstSeenAtMs = await this.#processedLog.firstSeenAtMs(mailboxId, eventId);
      } catch (err) {
        // Age bound unavailable for this deposit — fall back to the attempt bound.
        this.logger.error("[InboxCatchupService] firstSeen lookup failed for " + eventId + ": " + (err && err.message ? err.message : err));
        firstSeenAtMs = 0;
      }
    }
    const ageMs = firstSeenAtMs > 0 ? (nowMs - firstSeenAtMs) : 0;
    const tooManyAttempts = attempts >= this.#maxDecryptAttempts;
    const tooOld = firstSeenAtMs > 0 && ageMs >= this.#maxQuarantineAgeMs;
    if (tooManyAttempts || tooOld) {
      this.logger.error(
        "[InboxCatchupService] quarantining undecryptable deposit mailboxId=" + mailboxId
        + " eventId=" + eventId + " after " + attempts + " attempts, ageMs=" + ageMs
        + " (" + (tooManyAttempts ? "attempt" : "age") + " bound)",
      );
      // Surface it BEFORE dropping — a quarantined deposit must never vanish silently.
      this.#emitQuarantined({ mailboxId, eventId, attempts, ageMs, reason: tooManyAttempts ? "attempts" : "age" });
      await this.#ackAndForget(sdk, mailboxId, eventId);
      return;
    }
    // REZ-11: it's staying buffered. Once it has failed enough times to look like
    // persistent poison (not a transient out-of-order miss), arm a short backoff
    // so the next reconnect doesn't immediately re-fetch+re-decrypt it again. The
    // first few retries are deliberately left unthrottled so genuine out-of-order
    // recovery stays fast. The wall-clock age bound still advances while skipped,
    // so nothing is permanently stranded.
    if (attempts >= DECRYPT_BACKOFF_AFTER_ATTEMPTS) {
      this.#decryptBackoffUntilMsByEvent.set(eventId, nowMs + DECRYPT_RETRY_BACKOFF_MS);
      if (this.#decryptBackoffUntilMsByEvent.size > 16384) {
        for (const [k, until] of this.#decryptBackoffUntilMsByEvent) {
          if (nowMs >= until) this.#decryptBackoffUntilMsByEvent.delete(k);
        }
      }
    }
  }
}
