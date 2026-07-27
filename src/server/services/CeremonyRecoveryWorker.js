import { PENDING_CEREMONY_STATES } from "../../records/domain/PendingCeremonyRecordV1.js";

/**
 * CeremonyRecoveryWorker — the resume + compensating-revoke logic for device-link registrations
 * (audit finding #3, 2026-07-27).
 *
 * PendingCeremonyStore made a registration durable; nothing ever read it back. `listResumable()`
 * and `listExpirable()` had no production caller, so every guarantee the journal was built to
 * provide — republish after a crash, revoke what a dead ceremony released — existed on paper only.
 *
 * Deliberately free of timers, transports and lifecycle: ServerDeviceLinkService owns those, and
 * owns the serialization against a live ceremony. This class is the decision procedure, so the
 * rules below can be tested directly rather than through a scheduler.
 *
 * ── THE TWO PHASES ────────────────────────────────────────────────────────────────────────────
 *
 * RESUME (before the deadline). Republish the EXACT stored sealed response and only then mark it
 * published. Recovery cannot mean "retry the ceremony": a fresh ceremony mints a different certId
 * (the id derives from a body including issuedAtMs), so a retry never converges on the registration
 * that already committed. Republishing the same record to the same owner-keyed slot is idempotent —
 * the durable-record store treats a byte-identical re-put as a retention refresh — which is what
 * makes this safe to run on every sweep. `markPublished` happens strictly AFTER the put returns, so
 * a crash in between simply republishes next time; marking first could record a publication that
 * never happened and permanently skip it.
 *
 * COMPENSATE (past the deadline, unconfirmed). The ceremony failed, and it may have released real
 * authority before failing. The home is asked, not guessed at:
 *
 *   1. If the certId is ALREADY in the account's revoked set, a previous sweep finished the job.
 *      Delete.
 *   2. Otherwise submit the CERT-BOUND revoke `{ revokedDeviceId, revokedCertId }`. The certId is
 *      not decoration: the home rejects the mutation unless that cert is exactly the one bound to
 *      that device, so this cannot revoke some later, unrelated registration of the same device.
 *   3. Re-read the authority state. The certId being in the revoked set is the proof the revoke
 *      COMMITTED — and because the home folds the revoke, the epoch bump and the propagation
 *      enqueue in one transaction, that same fact proves propagation was enqueued. Only then delete.
 *   4. If the home REJECTS the binding (BAD_TARGET), `device.add` never committed for this
 *      registration. That is a disproof of commitment — but it only makes the row safe to drop if
 *      the leaf never escaped, i.e. the response was never published.
 *   5. Anything else — a revoke that reports success without the cert appearing in the revoked set,
 *      a published registration whose cert the home denies, a transport failure — leaves the
 *      journal in place and RAISES. Commitment that cannot be disproved is treated as commitment.
 *
 * The bias throughout is that a retained journal row costs storage, while a dropped one can strand
 * a live leaf that no longer has anything able to revoke it.
 */

/** Why a sweep left a record alone, or what it did to it. */
export const CEREMONY_RECOVERY_OUTCOMES = Object.freeze({
  REPUBLISHED: "republished",
  ALREADY_REVOKED: "already-revoked",
  REVOKED: "revoked",
  DISPROVEN: "disproven",
  RETAINED: "retained",
});

export class CeremonyRecoveryWorker {
  #journal;
  #records;
  #submitMutation;
  #getAuthorityState;
  #clock;
  #logger;

  /**
   * @param {object} deps
   * @param {import("../storage/PendingCeremonyStore.js").PendingCeremonyStore} deps.journal
   * @param {{ put(args:{record:object}):Promise<any> }} deps.records - sdk.durableRecords
   * @param {(args:{action:string,target:object})=>Promise<any>} deps.submitMutation
   * @param {()=>Promise<{revokedCertIds:string[]}>} deps.getAuthorityState
   */
  constructor({ journal, records, submitMutation, getAuthorityState, clock = () => Date.now(), logger = console } = {}) {
    if (!journal || typeof journal.listResumable !== "function" || typeof journal.listCompensatable !== "function") {
      throw new Error("CeremonyRecoveryWorker requires a journal with listResumable + listCompensatable");
    }
    if (!records || typeof records.put !== "function") {
      throw new Error("CeremonyRecoveryWorker requires records.put (the durable-record publisher)");
    }
    if (typeof submitMutation !== "function") {
      throw new Error("CeremonyRecoveryWorker requires submitMutation");
    }
    if (typeof getAuthorityState !== "function") {
      throw new Error("CeremonyRecoveryWorker requires getAuthorityState");
    }
    this.#journal = journal;
    this.#records = records;
    this.#submitMutation = submitMutation;
    this.#getAuthorityState = getAuthorityState;
    this.#clock = typeof clock === "function" ? clock : () => Date.now();
    this.#logger = logger || console;
  }

  /**
   * One full sweep: resume everything still in time, compensate everything that ran out of it.
   *
   * Never throws for a single bad record — one stuck registration must not stop the others from
   * being recovered. Faults are collected and reported so the caller can log/alert on them.
   *
   * @param {{ skipDeviceIds?: Set<string>|string[] }} [opts] - devices an ACTIVE ceremony owns
   * @returns {Promise<{ republished: string[], revoked: string[], disproven: string[], retained: Array<{deviceId:string, reason:string}>, skipped: string[] }>}
   */
  async sweep({ skipDeviceIds = null } = {}) {
    const skip = skipDeviceIds instanceof Set
      ? skipDeviceIds
      : new Set(Array.isArray(skipDeviceIds) ? skipDeviceIds : []);
    const result = { republished: [], revoked: [], disproven: [], retained: [], skipped: [] };

    const now = this.#clock();
    for (const record of await this.#journal.listResumable()) {
      if (skip.has(record.deviceId)) { result.skipped.push(record.deviceId); continue; }
      if (record.expiresAtMs <= now) continue; // the compensation pass owns it
      try {
        await this.#resume(record);
        result.republished.push(record.deviceId);
      } catch (err) {
        result.retained.push({ deviceId: record.deviceId, reason: this.#reason(err) });
        this.#logger.error(
          "[CeremonyRecovery] could not republish the stored response for " + record.deviceId
            + " — the registration stays pending and the next sweep retries: " + this.#reason(err),
        );
      }
    }

    for (const record of await this.#journal.listCompensatable()) {
      if (skip.has(record.deviceId)) { result.skipped.push(record.deviceId); continue; }
      try {
        const outcome = await this.#compensate(record);
        if (outcome === CEREMONY_RECOVERY_OUTCOMES.DISPROVEN) result.disproven.push(record.deviceId);
        else result.revoked.push(record.deviceId);
      } catch (err) {
        result.retained.push({ deviceId: record.deviceId, reason: this.#reason(err) });
        // Loud by design: an uncompensated expired ceremony may be live authority off-home.
        this.#logger.error(
          "[CeremonyRecovery] RETAINING the journal for " + record.deviceId
            + " — its released authority could NOT be compensated and may still be live off-home: "
            + this.#reason(err),
        );
      }
    }
    return result;
  }

  /** Republish the exact stored bytes, then record that they are out. Order is load-bearing. */
  async #resume(record) {
    await this.#records.put({ record: record.sealedResponse });
    await this.#journal.markPublished(record.deviceId);
    this.#logger.info(
      "[CeremonyRecovery] republished the stored device-link response for " + record.deviceId
        + " (registration resumed, not restarted)",
    );
  }

  /**
   * Compensate one expired, unconfirmed registration. Returns the outcome, or THROWS to signal
   * "retain the journal" — the caller turns that into a loud, retained failure.
   */
  async #compensate(record) {
    // A pending record moves to `expired` first so the durable state matches reality even if the
    // revoke below fails. A published one has no such transition (published → confirmed only), and
    // deliberately keeps its state: what makes it recoverable is the certId, not the label.
    if (record.state === PENDING_CEREMONY_STATES.PENDING) {
      await this.#journal.markExpired(record.deviceId);
    }

    if (await this.#certIsRevoked(record.certId)) {
      // A previous sweep already committed the revoke and died before deleting. Idempotent finish.
      await this.#journal.deleteAfterRevoke(record.deviceId, {
        revokeCommitted: true,
        revokedCertId: record.certId,
      });
      this.#logger.info("[CeremonyRecovery] " + record.deviceId
        + " was already revoked at the home; journal cleared");
      return CEREMONY_RECOVERY_OUTCOMES.ALREADY_REVOKED;
    }

    let rejectedBinding = false;
    try {
      const submitted = await this.#submitMutation({
        action: "device.revoke",
        // CERT-BOUND. The home requires revokedCertId to equal the cert it has bound to this
        // device and rejects a mismatch, so this can only ever revoke THIS registration — never a
        // later, legitimate re-registration of the same device.
        target: { revokedDeviceId: record.deviceId, revokedCertId: record.certId },
      });
      if (!submitted || typeof submitted !== "object") {
        // The account-mutation service answers null when it is not enabled on this runtime. That
        // is a DECLINE, not a revoke — saying so here keeps the failure actionable instead of
        // surfacing later as the far more alarming "the revoke succeeded but the cert is not
        // revoked".
        throw new Error(
          "the account-mutation service declined the compensating revoke (not enabled on this"
            + " runtime), so nothing was submitted",
        );
      }
    } catch (err) {
      if (this.#isBindingRejection(err)) {
        rejectedBinding = true;
      } else {
        throw err;
      }
    }

    if (!rejectedBinding) {
      // PROOF, not optimism: the certId appearing in the account's revoked set is what the home
      // writes in the same transaction that bumps the epoch and enqueues propagation. A revoke
      // that "succeeded" without it has not achieved what this compensation exists to achieve.
      if (!(await this.#certIsRevoked(record.certId))) {
        throw new Error(
          "the revoke reported success but certId " + record.certId
            + " is still absent from the account's revoked set",
        );
      }
      await this.#journal.deleteAfterRevoke(record.deviceId, {
        revokeCommitted: true,
        revokedCertId: record.certId,
      });
      this.#logger.warn(
        "[CeremonyRecovery] compensated an expired device-link for " + record.deviceId
          + ": its leaf cert is revoked and the revocation is queued for propagation",
      );
      return CEREMONY_RECOVERY_OUTCOMES.REVOKED;
    }

    // The home denies this cert binding, so device.add never committed for this registration.
    if (record.state !== PENDING_CEREMONY_STATES.PENDING
        && record.state !== PENDING_CEREMONY_STATES.EXPIRED) {
      throw new Error(
        "the home does not bind certId " + record.certId + " to " + record.deviceId
          + ", but this registration was already PUBLISHED — a released leaf with nothing able to"
          + " revoke it. Retaining the journal for operator attention.",
      );
    }
    await this.#journal.deleteAfterDisprovenCommit(record.deviceId, {
      homeRejectedCertBinding: true,
      neverPublished: true,
      certId: record.certId,
    });
    this.#logger.info(
      "[CeremonyRecovery] " + record.deviceId + " never committed at the home and never published"
        + " its response; nothing was released, journal cleared",
    );
    return CEREMONY_RECOVERY_OUTCOMES.DISPROVEN;
  }

  async #certIsRevoked(certId) {
    const state = await this.#getAuthorityState();
    // Strict: a malformed authority read is NOT "not revoked". Coercing it would turn a backend
    // hiccup into a confident "still live", and on the already-revoked branch into a redundant
    // revoke — but on the post-revoke branch into a retained failure, which is the safe direction
    // only by luck. Fail loud instead.
    if (!state || typeof state !== "object" || !Array.isArray(state.revokedCertIds)) {
      throw new Error("the account authority state could not be read (no revokedCertIds array)");
    }
    return state.revokedCertIds.includes(certId);
  }

  /**
   * Does this error mean "the home does not bind that cert to that device"? The home answers
   * BAD_TARGET for a revokedCertId that is not the device's bound cert — which includes the
   * never-enrolled case, where there is no bound cert at all.
   */
  #isBindingRejection(err) {
    if (!err) return false;
    if (err.code === "BAD_TARGET") return true;
    const message = typeof err.message === "string" ? err.message : "";
    return message.includes("BAD_TARGET");
  }

  #reason(err) {
    return err && err.message ? err.message : String(err);
  }
}
