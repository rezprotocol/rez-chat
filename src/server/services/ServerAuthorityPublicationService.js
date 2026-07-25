import { BaseServerService } from "../base/BaseServerService.js";

/**
 * ServerAuthorityPublicationService — the CLIENT drain worker for the account
 * authority-state propagation outbox (P1#3 leaf 5b).
 *
 * The home enqueues a publication obligation inside the same transaction that folds a device
 * add/revoke, but it cannot discharge it: an AccountAuthorityStateV1 is ACCOUNT-signed and the
 * node holds no account key. This service is the authorized device that discharges it, one
 * lease at a time:
 *
 *   claim   → take the account's single cluster-wide publication lease
 *   prepare → FREEZE the epoch M this lease will publish
 *   read    → the home's current authority state
 *   publish → build + sign the record for exactly M, submit it via complete()
 *
 * WHY THE EPOCH MUST MATCH. prepare() freezes M, but the state we build from is the home's
 * CURRENT state, and the head can advance between the two. There is no historical snapshot to
 * fetch — an outbox row carries only (account, epoch, kind), no payload — so publishing a
 * newer epoch than the frozen one is not an option: the node binds the completion to
 * prepared_epoch and answers CONFLICT. The only sound move is to RELEASE and re-claim, which
 * anchors at the new head. Because the drain is cumulative (publishing epoch M completes every
 * obligation <= M), that converges as soon as mutations pause.
 *
 * FAILURE IS REPORTED, NEVER SWALLOWED. Any fault while holding a live lease calls fail() so
 * the node records the attempt against the epoch it was actually attempting, applies bounded
 * backoff, and — at the threshold — stamps an operator-visible blocked state. The obligation is
 * never marked done and never abandoned: it stays outstanding until a verified publication, or
 * until a superseding verified epoch completes it. The original error is always rethrown.
 *
 * This service does NOT publish on its own schedule and does not yet replace the inline
 * publish in ServerAccountMutationService#propagate — that cutover is a separate slice. Callers
 * drive it through the `authority-publication` / `drain` directive.
 */

// One drain call handles a bounded number of lease cycles. A cycle ends by publishing, by
// finding nothing to publish, or by losing a race with a concurrent mutation; more than a few
// consecutive races means the account is mutating faster than it can publish, and the caller
// should come back later rather than spin.
const DEFAULT_MAX_CYCLES = 4;

export class ServerAuthorityPublicationService extends BaseServerService {
  #clock;

  constructor({ bus, ownerAccountId, clock = () => Date.now(), logger = console } = {}) {
    super({ bus, ownerAccountId, logger });
    this.#clock = typeof clock === "function" ? clock : () => Date.now();
    this._register("authority-publication", "drain", (payload) => this.drainPublications(payload || {}));
  }

  #sdk() {
    return this.bus.runtime && this.bus.runtime.sdk ? this.bus.runtime.sdk : null;
  }

  #outbox() {
    const sdk = this.#sdk();
    return sdk && sdk.accountOutbox ? sdk.accountOutbox : null;
  }

  #devices() {
    const sdk = this.#sdk();
    return sdk && sdk.devices ? sdk.devices : null;
  }

  #peerLinks() {
    return this.bus.runtime && this.bus.runtime.peerLinks ? this.bus.runtime.peerLinks : null;
  }

  /**
   * True when this runtime can actually drain: the outbox surface, the authority-state reader,
   * and the account-signing record builder must all be present. A runtime missing any of them
   * (no per-device sessions, or an SDK predating the outbox) drains nothing.
   */
  isEnabled() {
    const outbox = this.#outbox();
    const devices = this.#devices();
    const peerLinks = this.#peerLinks();
    return Boolean(
      outbox
        && typeof outbox.claim === "function"
        && devices
        && typeof devices.getAuthorityState === "function"
        && peerLinks
        && typeof peerLinks.buildAccountAuthorityStateRecord === "function",
    );
  }

  /**
   * Drain this account's pending authority-state publications.
   *
   * @param {object} [opts]
   * @param {number} [opts.maxCycles] — lease cycles to attempt before returning (default 4)
   * @returns {Promise<{ enabled: boolean, cycles: number, publishedEpochs: number[], stopped: string }>}
   *     `stopped` is why the drain ended: "disabled", "outbox-unavailable", "nothing-pending",
   *     "lease-lost", or "max-cycles".
   * @throws whatever failed while a lease was held — after reporting the failed attempt.
   */
  async drainPublications({ maxCycles = DEFAULT_MAX_CYCLES } = {}) {
    if (!this.isEnabled()) {
      return { enabled: false, cycles: 0, publishedEpochs: [], stopped: "disabled" };
    }
    const limit = Number.isInteger(maxCycles) && maxCycles > 0 ? maxCycles : DEFAULT_MAX_CYCLES;
    const publishedEpochs = [];
    let cycles = 0;

    while (cycles < limit) {
      cycles += 1;
      let claim;
      try {
        claim = await this.#outbox().claim();
      } catch (err) {
        // A node without the outbox (fs / relay / desktop-local) answers SERVICE_UNAVAILABLE.
        // That is a deployment fact, not a fault: report it and stop, don't retry or throw.
        if (err && err.code === "SERVICE_UNAVAILABLE") {
          this.logger.info("[ServerAuthorityPublicationService] node has no propagation outbox; nothing to drain");
          return { enabled: true, cycles, publishedEpochs, stopped: "outbox-unavailable" };
        }
        throw err;
      }
      // Not leased: nothing pending, another device holds the lease, or the head is backing off
      // after a failed attempt. All three mean "not this device's turn right now".
      if (claim.leased !== true) {
        return { enabled: true, cycles, publishedEpochs, stopped: "nothing-pending" };
      }

      const outcome = await this.#publishUnderLease(claim.token);
      if (outcome.publishedEpoch !== null) {
        publishedEpochs.push(outcome.publishedEpoch);
      }
      if (outcome.stop === true) {
        return { enabled: true, cycles, publishedEpochs, stopped: outcome.reason };
      }
      // Otherwise loop: either we published (and the head may have advanced again while we did),
      // or we lost the race and released. A fresh claim anchors at whatever the head is now.
    }
    return { enabled: true, cycles, publishedEpochs, stopped: "max-cycles" };
  }

  /**
   * One lease cycle, from a held lease to a completed publication. Returns
   * { stop, reason, publishedEpoch }; `stop: false` means the caller should re-claim.
   */
  async #publishUnderLease(leaseToken) {
    const outbox = this.#outbox();

    const prepared = await outbox.prepare({ leaseToken });
    if (prepared.prepared !== true) {
      // The lease lapsed, was released, or this device was revoked. Another device re-drains.
      return { stop: true, reason: "lease-lost", publishedEpoch: null };
    }
    // The FROZEN epoch. A repeat prepare under this lease returns this same value, so it cannot
    // drift out from under an in-flight publish.
    const frozenEpoch = prepared.headEpoch;

    try {
      const state = await this.#devices().getAuthorityState();
      if (state.epoch < frozenEpoch) {
        // The home owes a publication for an epoch its own authority has not reached. That is an
        // invariant violation (the obligation is enqueued in the fold that bumps the epoch), not
        // a race — fail loud rather than publishing a state that contradicts the obligation.
        throw new Error(
          "ServerAuthorityPublicationService: home authority epoch " + state.epoch
            + " is BEHIND the prepared publication epoch " + frozenEpoch,
        );
      }
      if (state.epoch !== frozenEpoch) {
        // The head advanced while we prepared. We may only complete the epoch we froze, and we
        // cannot reconstruct the older state, so give the lease up cleanly and re-claim at the
        // new head. No backoff: the obligation is immediately eligible again.
        await outbox.release({ leaseToken });
        return { stop: false, reason: "head-advanced", publishedEpoch: null };
      }

      const built = await this.#peerLinks().buildAccountAuthorityStateRecord({
        epoch: frozenEpoch,
        revokedCertIds: state.revokedCertIds,
        minValidIssuedAtMs: state.minValidIssuedAtMs,
        nowMs: this.#clock(),
      });
      const completed = await outbox.complete({ leaseToken, record: built.record });
      if (completed.completed !== true) {
        // The benign race: the lease lapsed while the node verified. The record is stored and
        // authentic regardless, so the next drain finds nothing new to publish.
        return { stop: true, reason: "lease-lost", publishedEpoch: null };
      }
      return { stop: false, reason: "published", publishedEpoch: completed.doneThroughEpoch };
    } catch (err) {
      await this.#reportFailedAttempt(leaseToken, err);
      throw err;
    }
  }

  /**
   * Report a failed attempt so the node releases the lease, backs off the epoch it was
   * ATTEMPTING, and counts toward the operator-visible blocked threshold. Never masks the
   * original fault: a failure to report is logged and swallowed HERE only because the caller
   * rethrows the real error immediately after — and an unreported lease still expires on its
   * own server-side TTL, so the obligation cannot be stranded.
   */
  async #reportFailedAttempt(leaseToken, cause) {
    const reason = cause && cause.message ? cause.message : String(cause);
    this.logger.warn("[ServerAuthorityPublicationService] publication attempt failed: " + reason);
    try {
      const recorded = await this.#outbox().fail({ leaseToken });
      if (recorded.recorded === true && recorded.blocked === true) {
        this.logger.error(
          "[ServerAuthorityPublicationService] authority-state publication is BLOCKED after "
            + recorded.attempts + " failed attempts (epoch " + recorded.attemptedEpoch
            + "); revocations are NOT reaching off-home peers and this needs operator attention",
        );
      }
    } catch (failErr) {
      this.logger.error(
        "[ServerAuthorityPublicationService] could not record the failed attempt: "
          + (failErr && failErr.message ? failErr.message : failErr)
          + "; the lease will expire on its server-side TTL",
      );
    }
  }
}
