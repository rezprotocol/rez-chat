/**
 * MobileLifecycleAdapter (M7, plans/MOBILE_LIFECYCLE_ADAPTER_PLAN.md §3/§7f)
 * — the thin scheduler between a mobile host's lifecycle notifications and
 * the already-proven runtime primitives. Deliberately "almost insultingly
 * boring" (the frozen pin): it holds NO domain logic, NO durable state, and
 * NO account-control handle; every hook funnels into one coalesced,
 * serialized converge pass over five idempotent, self-deciding directives:
 *
 *     1. runtime.ensureLive        (M2 — connect/kick/bind)
 *     2. runtime.renewLeaseIfDue   (M3 — durable lease + now, TTL/2)
 *     3. inbox.drain               (M2 — the coalesced catch-up drain)
 *     4. message.commit.sweep      (shipped — durable rows + now)
 *     5. sibling-sync.syncAll      (shipped/M4 — throttled, defer-aware)
 *
 * The order is frozen (§7c): transport and mailbox viability are restored
 * before repair work. Every correctness decision is reconstructed from
 * durable state + now by the DIRECTIVES — the adapter never derives work
 * itself, so a phone arbitrarily suspended between wakes loses nothing.
 *
 * Coalescing (§7f pin 2): ONE current pass + ONE dirty bit. A wake arriving
 * mid-pass marks rerun; completion triggers exactly one more pass — a wake
 * storm can never become N back-to-back full convergence rounds, yet a state
 * change arriving mid-pass is always observed by the follow-up pass. Reason
 * strings are accumulated for diagnostics only.
 *
 * Failure semantics (§7f pin 1): a failed ensureLive short-circuits the rest
 * of THAT pass (still offline — nothing else can run) and poisons nothing;
 * the next wake starts clean. Once live, each remaining step is best-effort:
 * a failed step is recorded and the sequence continues (a failed sibling
 * sync must not block the drain's completed ack work, and vice versa).
 * Hooks NEVER throw at the host.
 *
 * Account authority (§7f pin 4, structural): the adapter is constructed
 * WITHOUT the AccountControlChannel handle. The only account-adjacent thing
 * it can do is the optional `suspendAccountControl` closure the wiring may
 * provide for onBackground — a close-only capability that cannot express
 * authority. Background wake paths therefore cannot open an account session
 * even by future accident.
 */
export class MobileLifecycleAdapter {
  #bus;
  #logger;
  #suspendAccountControl;

  #running;
  #rerun;
  #pendingReasons;
  #currentPassPromise;
  #lastReport;

  constructor({ bus, suspendAccountControl = null, logger = console } = {}) {
    if (!bus || typeof bus !== "object" || typeof bus.call !== "function") {
      throw new Error("MobileLifecycleAdapter requires bus (with call)");
    }
    if (suspendAccountControl !== null && typeof suspendAccountControl !== "function") {
      throw new Error("MobileLifecycleAdapter suspendAccountControl must be a function when provided");
    }
    this.#bus = bus;
    this.#logger = logger || console;
    this.#suspendAccountControl = suspendAccountControl;
    this.#running = false;
    this.#rerun = false;
    this.#pendingReasons = [];
    this.#currentPassPromise = null;
    this.#lastReport = null;
  }

  /** The last completed converge pass report (diagnostics; null before any pass). */
  get lastReport() {
    return this.#lastReport;
  }

  // ---- Host hooks (the frozen shape). Each returns the converge promise so
  // hosts/tests MAY await completion, but none ever rejects. ----

  onForeground() {
    return this.#requestConverge("foreground");
  }

  onPushWake() {
    return this.#requestConverge("push-wake");
  }

  onNetworkAvailable() {
    return this.#requestConverge("network-available");
  }

  onPeriodicWake() {
    return this.#requestConverge("periodic-wake");
  }

  /**
   * Backgrounding (§7f pin 3): suspend the on-demand account channel now
   * rather than waiting out its idle timer — best-effort, idempotent,
   * NEVER a host-visible failure. The data-plane session is left to the OS
   * (reconnect/re-bind is idempotent; no protocol goodbye exists or is
   * needed). No converge runs here — backgrounding is a stand-down, not a
   * wake.
   */
  async onBackground() {
    if (!this.#suspendAccountControl) return { suspended: false, reason: "no-account-control" };
    try {
      const result = await this.#suspendAccountControl();
      return result && typeof result === "object" ? result : { suspended: true };
    } catch (err) {
      this.#logger.error("[MobileLifecycleAdapter] account-control suspend failed (ignored — suspension must not block): "
        + (err && err.message ? err.message : err));
      return { suspended: false, reason: "suspend-failed" };
    }
  }

  // ---- The one coalesced pass ----

  #requestConverge(reason) {
    this.#pendingReasons.push(reason);
    if (this.#running) {
      // §7f pin 2: one dirty bit, not a queue. This wake's state change is
      // observed by the single follow-up pass.
      this.#rerun = true;
      return this.#currentPassPromise;
    }
    this.#running = true;
    this.#currentPassPromise = (async () => {
      let report = null;
      do {
        this.#rerun = false;
        const reasons = this.#pendingReasons.splice(0);
        report = await this.#convergeOnce(reasons);
        this.#lastReport = report;
      } while (this.#rerun);
      return report;
    })().finally(() => {
      this.#running = false;
      this.#currentPassPromise = null;
    });
    return this.#currentPassPromise;
  }

  // One converge pass. Never throws; the report says what ran and what
  // failed. Steps run only when their directive is registered — a runtime
  // wired without one of the services simply skips that step (the adapter
  // must not invent requirements the runtime doesn't have).
  async #convergeOnce(reasons) {
    const report = { reasons, startedAtMs: Date.now(), steps: {}, live: false };

    // 1. ensureLive — the gate. Still offline short-circuits the pass: no
    // other step can do anything without a session, and each will re-derive
    // its own work from durable state on the next wake.
    try {
      if (this.#has("runtime", "ensureLive")) {
        await this.#bus.call("runtime", "ensureLive", {});
      }
      report.live = true;
      report.steps.ensureLive = { ok: true };
    } catch (err) {
      report.steps.ensureLive = { ok: false, error: err && err.message ? err.message : String(err) };
      this.#logger.warn("[MobileLifecycleAdapter] converge short-circuited (offline): " + report.steps.ensureLive.error);
      return report;
    }

    // 2–5. Best-effort, in the frozen order. A step's failure is recorded
    // and the sequence continues.
    await this.#step(report, "renewLeaseIfDue", "runtime", "renewLeaseIfDue");
    await this.#step(report, "drain", "inbox", "drain");
    await this.#step(report, "commitSweep", "message.commit", "sweep");
    await this.#step(report, "siblingSync", "sibling-sync", "syncAll");
    return report;
  }

  async #step(report, label, namespace, name) {
    if (!this.#has(namespace, name)) {
      report.steps[label] = { ok: true, skipped: true };
      return;
    }
    try {
      const result = await this.#bus.call(namespace, name, {});
      report.steps[label] = { ok: true, result };
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      report.steps[label] = { ok: false, error: message };
      this.#logger.error("[MobileLifecycleAdapter] converge step " + label + " failed (sequence continues): " + message);
    }
  }

  #has(namespace, name) {
    const fns = this.#bus.functions && this.#bus.functions[namespace];
    return Boolean(fns && typeof fns[name] === "function");
  }
}
