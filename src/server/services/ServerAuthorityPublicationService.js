import { BaseServerService } from "../base/BaseServerService.js";

/**
 * ServerAuthorityPublicationService — the CLIENT drain worker for the account
 * authority-state propagation outbox (P1#3 leaf 5b).
 *
 * The home enqueues a publication obligation inside the same transaction that folds a device
 * add/revoke, but it cannot discharge it: an AccountAuthorityStateV1 is ACCOUNT-signed and the
 * node holds no account key. This service is the authorized device that discharges it, one
 * lease at a time.
 *
 * WHO CAN DRAIN. Only a PRIMARY (account-root) session. Since the audit P0 fix the authority state
 * is root-signed only — the record that decides who is authorized cannot be authored by a delegated
 * signer, or the device a revocation names could rewrite it. The outbox stores an OBLIGATION, not a
 * signed payload, so there is nothing for a delegated device to merely relay: authoring it requires
 * the account key. A delegated session's claim is therefore refused with `awaitingRootSignature`
 * and this service stops cleanly, without taking a lease it could only fail out of.
 *
 * The cycle:
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
 * RECOVERY LIVENESS (audit finding #2, 2026-07-26). A drain used to happen only when THIS device
 * mutated its own account — `ServerAccountMutationService` calls the directive right after its fold
 * commits. That covers the local case and nothing else, so an obligation was stranded whenever:
 *   - another device performed the mutation (this device sees no local event, and the mutating
 *     device may be delegated and unable to sign it);
 *   - this process died between the enqueue and the publish;
 *   - the head was backing off after a failed attempt, and no further mutation ever arrived to
 *     trigger a retry.
 * In all three the obligation stayed durable and correct — and simply never ran. Honest reporting
 * is not liveness.
 *
 * So the service now also drives itself: once at start, on every SDK reconnect, and on a periodic
 * safety net with exponential backoff after failures. The mutation-driven call is unchanged and
 * remains the fast path; this is the net underneath it.
 *
 * SUSPENSION. Three outcomes mean polling cannot help, and the timer stands down until the next
 * reconnect rather than burning wakeups: `disabled` (this runtime cannot drain at all),
 * `outbox-unavailable` (this node has no outbox), and `awaiting-root-signature` (this device is
 * delegated, and its own session authority cannot change without re-authenticating). Reconnect
 * clears the suspension, because any of the three may be answered differently by a different node
 * or a new session.
 */

// One drain call handles a bounded number of lease cycles. A cycle ends by publishing, by
// finding nothing to publish, or by losing a race with a concurrent mutation; more than a few
// consecutive races means the account is mutating faster than it can publish, and the caller
// should come back later rather than spin.
const DEFAULT_MAX_CYCLES = 4;

// The safety-net cadence. Deliberately slow: the fast paths (a local mutation, and the mutating
// device's own drain) already cover the common case, so this only has to catch the stranded
// remainder. Polling faster would spend cluster-wide lease budget to shave minutes off a recovery
// that is already rare.
const DEFAULT_RETRY_INTERVAL_MS = 300_000;

// After a THROWN drain the interval doubles up to this ceiling, then holds. A drain that throws has
// already reported the failed attempt to the node (which applies its own per-epoch backoff and the
// blocked threshold); this second, client-side backoff exists so a persistently broken client does
// not keep claiming the account's single cluster-wide lease and starving a healthy sibling device.
const DEFAULT_MAX_RETRY_INTERVAL_MS = 1_800_000;

export class ServerAuthorityPublicationService extends BaseServerService {
  #clock;
  #retryIntervalMs;
  #maxRetryIntervalMs;
  #currentRetryMs;
  #timer;
  #setTimer;
  #clearTimer;
  #offReconnect;
  #stopped;
  #suspendedReason;
  #draining;
  #pending;

  constructor({
    bus,
    ownerAccountId,
    clock = () => Date.now(),
    logger = console,
    retryIntervalMs = DEFAULT_RETRY_INTERVAL_MS,
    maxRetryIntervalMs = DEFAULT_MAX_RETRY_INTERVAL_MS,
    // Injectable so tests drive the schedule deterministically instead of waiting on wall clock.
    // Defaults are the real timers; nothing in production passes these.
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (handle) => clearTimeout(handle),
  } = {}) {
    super({ bus, ownerAccountId, logger });
    this.#clock = typeof clock === "function" ? clock : () => Date.now();
    this.#retryIntervalMs = Number.isFinite(retryIntervalMs) && retryIntervalMs > 0
      ? Number(retryIntervalMs)
      : DEFAULT_RETRY_INTERVAL_MS;
    this.#maxRetryIntervalMs = Number.isFinite(maxRetryIntervalMs) && maxRetryIntervalMs >= this.#retryIntervalMs
      ? Number(maxRetryIntervalMs)
      : Math.max(this.#retryIntervalMs, DEFAULT_MAX_RETRY_INTERVAL_MS);
    this.#currentRetryMs = this.#retryIntervalMs;
    this.#setTimer = typeof setTimer === "function" ? setTimer : ((fn, ms) => setTimeout(fn, ms));
    this.#clearTimer = typeof clearTimer === "function" ? clearTimer : ((handle) => clearTimeout(handle));
    this.#timer = null;
    this.#offReconnect = null;
    this.#stopped = false;
    this.#suspendedReason = null;
    this.#draining = false;
    this.#pending = false;
    this._register("authority-publication", "drain", (payload) => this.drainPublications(payload || {}));
  }

  /**
   * Arm the recovery net: subscribe to reconnect, run one drain now, and schedule the periodic
   * retry. Never throws — a drain failure at boot must not take the chat server down with it, and
   * the obligation is durable either way.
   */
  async start() {
    this.#stopped = false;
    const sdk = this.#sdk();
    const connectivity = sdk && sdk.connectivity ? sdk.connectivity : null;
    if (connectivity && typeof connectivity.onReconnected === "function") {
      this.#offReconnect = connectivity.onReconnected(() => this.#onReconnected());
    } else {
      // Degraded, but loudly: startup + periodic retry still run. A runtime without connectivity
      // (some unit-test wirings) would otherwise appear to have full recovery coverage.
      this.logger.warn(
        "[ServerAuthorityPublicationService] sdk.connectivity.onReconnected is unavailable;"
          + " running startup + periodic recovery only, with no reconnect-triggered drain",
      );
    }
    await this.requestDrain("startup");
  }

  async stop() {
    this.#stopped = true;
    this.#cancelTimer();
    if (typeof this.#offReconnect === "function") {
      try {
        this.#offReconnect();
      } catch (err) {
        this.logger.error("[ServerAuthorityPublicationService] reconnect unsubscribe failed: "
          + (err && err.message ? err.message : err));
      }
      this.#offReconnect = null;
    }
    await super.stop();
  }

  /**
   * A drain that never throws — the entry point for every SELF-driven trigger (startup, reconnect,
   * the periodic net). It reports the outcome, decides whether to keep polling, and reschedules.
   *
   * The directive path (`authority-publication`/`drain` → drainPublications) keeps its throwing
   * contract untouched: ServerAccountMutationService needs the real error to log what a committed
   * mutation failed to propagate.
   *
   * Concurrent drains are SAFE rather than prevented: the outbox lease is serialized cluster-wide,
   * so a second claim simply answers `leased: false`. This coalescer only keeps the self-driven
   * triggers from stacking on each other; it deliberately does not gate the directive, which must
   * run and report on its own.
   *
   * @param {string} trigger - "startup" | "reconnect" | "periodic", for logs
   */
  async requestDrain(trigger) {
    if (this.#draining) {
      this.#pending = true;
      return;
    }
    this.#draining = true;
    try {
      do {
        this.#pending = false;
        await this.#runOnce(trigger);
      } while (this.#pending && !this.#stopped);
    } finally {
      this.#draining = false;
    }
  }

  // One self-driven drain: run it, classify the outcome, and set up the next wakeup.
  async #runOnce(trigger) {
    if (this.#stopped) return;
    let outcome;
    try {
      outcome = await this.drainPublications({});
    } catch (err) {
      // drainPublications already reported the failed attempt to the node before rethrowing, so
      // the obligation is backed off server-side and never lost. Here we only decide when THIS
      // client tries again — backing off so a persistently broken device stops taking the lease.
      const next = this.#backoff();
      this.logger.error(
        "[ServerAuthorityPublicationService] " + trigger + " drain failed: "
          + (err && err.message ? err.message : err)
          + "; retrying in " + Math.round(next / 1000) + "s",
      );
      this.#scheduleNext(next);
      return;
    }
    this.#resetBackoff();
    if (this.#shouldSuspend(outcome)) {
      this.#suspendedReason = outcome.enabled === false ? "disabled" : outcome.stopped;
      this.#cancelTimer();
      this.logger.info(
        "[ServerAuthorityPublicationService] periodic recovery suspended (" + this.#suspendedReason
          + "); polling cannot change this outcome — it will re-arm on the next reconnect",
      );
      return;
    }
    this.#suspendedReason = null;
    this.#scheduleNext(this.#currentRetryMs);
  }

  /**
   * Outcomes that polling cannot change. Each is a property of THIS runtime, THIS node, or THIS
   * session's authority — none of which shifts without a reconnect. `nothing-pending`, `lease-lost`
   * and `max-cycles` are all transient by contrast and keep the normal cadence.
   */
  #shouldSuspend(outcome) {
    if (!outcome || typeof outcome !== "object") return false;
    if (outcome.enabled === false) return true;
    return outcome.stopped === "outbox-unavailable" || outcome.stopped === "awaiting-root-signature";
  }

  #onReconnected() {
    // A new session may be on a different node, or hold different authority, so every suspension
    // reason is re-evaluated from scratch.
    this.#suspendedReason = null;
    this.#resetBackoff();
    this.requestDrain("reconnect").catch((err) => {
      // requestDrain does not throw; this is belt-and-braces so a bug here can never surface as an
      // unhandled rejection inside a transport callback.
      this.logger.error("[ServerAuthorityPublicationService] reconnect drain failed: "
        + (err && err.message ? err.message : err));
    });
  }

  #scheduleNext(delayMs) {
    this.#cancelTimer();
    if (this.#stopped) return;
    this.#timer = this.#setTimer(() => {
      this.#timer = null;
      // The promise is RETURNED, not dropped. A real timer ignores it; an injected scheduler can
      // await it, which is what lets the tests assert the cadence deterministically instead of
      // racing a drain that is still in flight.
      return this.requestDrain("periodic").catch((err) => {
        this.logger.error("[ServerAuthorityPublicationService] periodic drain failed: "
          + (err && err.message ? err.message : err));
      });
    }, delayMs);
    // Never hold the process open for a safety net.
    if (this.#timer && typeof this.#timer.unref === "function") this.#timer.unref();
  }

  #cancelTimer() {
    if (this.#timer !== null) {
      this.#clearTimer(this.#timer);
      this.#timer = null;
    }
  }

  #backoff() {
    this.#currentRetryMs = Math.min(this.#currentRetryMs * 2, this.#maxRetryIntervalMs);
    return this.#currentRetryMs;
  }

  #resetBackoff() {
    this.#currentRetryMs = this.#retryIntervalMs;
  }

  /** Scheduler state, for tests and diagnostics. */
  get recoveryState() {
    return {
      scheduled: this.#timer !== null,
      suspendedReason: this.#suspendedReason,
      nextRetryMs: this.#currentRetryMs,
    };
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
   *     "awaiting-root-signature", "lease-lost", or "max-cycles".
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
      // AWAITING ROOT SIGNATURE. The account authority state is root-signed only, so a delegated
      // device cannot author the publication. The node refuses the lease outright rather than
      // handing over one this device could only fail out of — so nothing was attempted, nothing
      // backed off, and the obligation stays immediately claimable by the primary.
      //
      // This is deliberately NOT folded into "nothing-pending": the two need different handling.
      // Nothing-pending is the steady state; this one means revocations are NOT reaching off-home
      // peers until a primary session runs, which a caller may want to surface to the user.
      if (claim.awaitingRootSignature === true) {
        this.logger.warn(
          "[ServerAuthorityPublicationService] this device is delegated and the account authority state is"
            + " root-signed only — the pending publication is waiting for a primary (account-root) session;"
            + " revocations will not reach off-home peers until one runs",
        );
        return { enabled: true, cycles, publishedEpochs, stopped: "awaiting-root-signature" };
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
