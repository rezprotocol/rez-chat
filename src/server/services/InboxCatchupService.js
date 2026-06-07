import { BaseServerService } from "../base/BaseServerService.js";

const DEFAULT_PAGE_LIMIT = 50;
// D1: after this many failed decrypts across drains, a deposit is treated as
// poison and quarantined (acked + dropped) so it can't be retried forever.
const DEFAULT_MAX_DECRYPT_ATTEMPTS = 8;

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
 *     has been applied) can decrypt it cleanly. A bounded attempt counter
 *     quarantines a genuinely-poison deposit (D1) so it can never wedge the drain.
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

  constructor({ bus, inboxClaimant, inboundPipeline, processedLog = null, pageLimit = DEFAULT_PAGE_LIMIT, maxDecryptAttempts = DEFAULT_MAX_DECRYPT_ATTEMPTS, logger = console } = {}) {
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
    await this.requestDrain();
  }

  async stop() {
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
    if (!sdk || !sdk.mailbox || typeof sdk.mailbox.list !== "function" || typeof sdk.mailbox.fetch !== "function" || typeof sdk.mailbox.ack !== "function") {
      throw new Error("InboxCatchupService requires sdk.mailbox.list/fetch/ack");
    }
    const mailboxId = this.#inboxClaimant.inboxId;
    if (typeof mailboxId !== "string" || mailboxId.length === 0) {
      throw new Error("InboxCatchupService: inboxClaimant.inboxId is not set");
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
        const ok = Boolean(result && (result.consumed || result.alreadyProcessed));
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

  // Remove a fully-consumed deposit from the relay buffer and prune its markers.
  async #ackAndForget(sdk, mailboxId, eventId) {
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
  // it crosses the bound (D1), quarantine it (ack + drop) so a single poison
  // deposit can never wedge catch-up. Otherwise leave it for the next drain.
  async #handleDecryptFailure(sdk, mailboxId, eventId) {
    if (!this.#processedLog || typeof this.#processedLog.recordAttempt !== "function") {
      // No attempt store wired: leave it buffered (best effort, no quarantine).
      this.logger.warn("[InboxCatchupService] deposit " + eventId + " left buffered (no attempt store to bound retries)");
      return;
    }
    let attempts = 0;
    try {
      attempts = await this.#processedLog.recordAttempt(mailboxId, eventId);
    } catch (err) {
      this.logger.error("[InboxCatchupService] attempt-counter record failed for " + eventId + ": " + (err && err.message ? err.message : err));
      return;
    }
    if (attempts >= this.#maxDecryptAttempts) {
      this.logger.error("[InboxCatchupService] quarantining undecryptable deposit mailboxId=" + mailboxId + " eventId=" + eventId + " after " + attempts + " attempts");
      await this.#ackAndForget(sdk, mailboxId, eventId);
    }
  }
}
