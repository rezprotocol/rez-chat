import { createRezClient } from "@rezprotocol/sdk/client";

const DEFAULT_IDLE_CLOSE_MS = 30_000;

/**
 * AccountControlChannel — the ON-DEMAND account-authority connection
 * (F8, plans/F8_REZCHAT_ROLE_SPLIT_PLAN.md).
 *
 * The claimant data plane never expresses account authority; when a genuine
 * control-plane operation is needed (device enrollment, authority
 * publication, device-set work), it runs through here:
 *
 *     execute(work) → connect → authenticate ACCOUNT → work(client) → idle close
 *
 * Frozen semantics (approval of F8 decision 3):
 * - Demand-driven, never a fallback transport, never proactively persistent.
 *   Nothing here opens a connection except an execute() call, and nothing
 *   outside control-plane work keeps one alive.
 * - Batching may EXTEND an already-needed session: an execute() arriving
 *   while the channel is open reuses it; the idle timer closes it once no
 *   work has run for `idleCloseMs`. Internal configuration, not a protocol
 *   knob.
 * - This object knows what authority it represents: it is constructed with
 *   the ACCOUNT identity and exposes no way to run mailbox traffic — the
 *   client it manages is handed only to the bounded `work` callback.
 */
export class AccountControlChannel {
  #identity;
  #uplinks;
  #wsFactory;
  #expectedNodePublicKeyB64;
  #clientVersion;
  #clientFactory;
  #idleCloseMs;
  #logger;

  #client = null;
  #connectPromise = null;
  #inFlight = 0;
  #idleTimer = null;
  #closed = false;
  // M4 instrumentation (plan §7b trace req. 4): every execute() is counted
  // and observable, so the adversarial suite can MECHANICALLY assert that no
  // background/wake path ever caused account authority to appear
  // (executeCount === 0 across the whole transition), instead of trusting
  // review to have spotted a call site.
  #executeCount = 0;
  #onExecute = null;

  constructor({
    identity,
    uplinks,
    wsFactory = null,
    expectedNodePublicKeyB64 = "",
    clientVersion = "rez-chat-server-control/1.0",
    idleCloseMs = DEFAULT_IDLE_CLOSE_MS,
    clientFactory = null,
    logger = console,
  } = {}) {
    if (!identity || typeof identity !== "object" || !identity.publicKeyB64) {
      throw new Error("AccountControlChannel requires the ACCOUNT identity");
    }
    if (!Array.isArray(uplinks) || uplinks.length === 0) {
      throw new Error("AccountControlChannel requires uplinks");
    }
    this.#identity = identity;
    this.#uplinks = uplinks;
    this.#wsFactory = wsFactory;
    this.#expectedNodePublicKeyB64 = typeof expectedNodePublicKeyB64 === "string" ? expectedNodePublicKeyB64.trim() : "";
    this.#clientVersion = clientVersion;
    this.#idleCloseMs = Number.isFinite(idleCloseMs) && idleCloseMs > 0 ? idleCloseMs : DEFAULT_IDLE_CLOSE_MS;
    this.#clientFactory = typeof clientFactory === "function" ? clientFactory : null;
    this.#logger = logger;
  }

  /** True while an account session is open (for tests and diagnostics). */
  get active() {
    return this.#client !== null;
  }

  /** Total execute() invocations over this channel's lifetime (M4 instrumentation). */
  get executeCount() {
    return this.#executeCount;
  }

  /**
   * Observe every execute() as it begins (M4 instrumentation). One observer;
   * returns an unsubscribe. Observer failures must never affect control work.
   */
  onExecute(handler) {
    if (typeof handler !== "function") {
      throw new Error("AccountControlChannel.onExecute requires a handler");
    }
    this.#onExecute = handler;
    return () => {
      if (this.#onExecute === handler) this.#onExecute = null;
    };
  }

  /**
   * Run one bounded control-plane operation against an ACCOUNT-authenticated
   * client. Opens the connection if none is active (demand-driven), reuses it
   * if control work is already in flight or within the idle window, and arms
   * the idle close when the last operation finishes.
   * @param {(client: object) => Promise<any>} work
   */
  async execute(work) {
    if (typeof work !== "function") {
      throw new Error("AccountControlChannel.execute requires a work function");
    }
    if (this.#closed) {
      throw new Error("AccountControlChannel is closed");
    }
    this.#executeCount += 1;
    if (this.#onExecute) {
      try {
        this.#onExecute({ executeCount: this.#executeCount });
      } catch (err) {
        this.#logger.error("[AccountControlChannel] onExecute observer failed: " + (err && err.message ? err.message : err));
      }
    }
    this.#clearIdleTimer();
    this.#inFlight += 1;
    try {
      const client = await this.#ensureClient();
      return await work(client);
    } finally {
      this.#inFlight -= 1;
      if (this.#inFlight === 0 && this.#client) {
        this.#armIdleTimer();
      }
    }
  }

  /** Immediate teardown (shutdown path). */
  async close() {
    this.#closed = true;
    this.#clearIdleTimer();
    await this.#teardownClient();
  }

  /**
   * M7 (plans/MOBILE_LIFECYCLE_ADAPTER_PLAN.md §7f): the BACKGROUNDING verb
   * — tear the account session down NOW instead of waiting out the idle
   * timer, WITHOUT killing the channel (close() is terminal; a backgrounded
   * app must still be able to run foreground control work after resume —
   * the next execute() rebuilds a fresh client). Idempotent and best-effort
   * by contract: no active session is a no-op, control work in flight is
   * left to finish (its completion arms the idle close as usual), and the
   * caller treats any error as log-only — there is no correctness reason to
   * block suspension on a bounded channel's teardown trouble.
   *
   * FROZEN SEMANTIC (Noah, program close 2026-08-25) — the two verbs answer
   * different questions and must never be collapsed:
   *   close()   = terminal OBJECT lifecycle (shutdown).
   *   suspend() = terminate AUTHORITY EXPOSURE now, retain the capability
   *               to perform future explicit control work.
   * `suspend() { return this.close(); }` is exactly the "simplification"
   * this note forbids: it would silently make every post-resume foreground
   * account operation impossible. The adapter suite pins post-resume
   * execute(), so the collapse also fails tests — but the semantic is the
   * law, not the test.
   * @returns {Promise<{suspended: boolean, reason?: string}>}
   */
  async suspend() {
    if (this.#closed) return { suspended: false, reason: "closed" };
    if (this.#inFlight > 0) return { suspended: false, reason: "work-in-flight" };
    this.#clearIdleTimer();
    if (!this.#client && !this.#connectPromise) return { suspended: false, reason: "no-session" };
    await this.#teardownClient();
    return { suspended: true };
  }

  async #ensureClient() {
    if (this.#client) return this.#client;
    if (this.#connectPromise) return this.#connectPromise;
    this.#connectPromise = (async () => {
      const client = this.#clientFactory
        ? await this.#clientFactory({
          identity: this.#identity,
          uplinks: this.#uplinks,
          wsFactory: this.#wsFactory,
          expectedNodePublicKeyB64: this.#expectedNodePublicKeyB64,
          clientVersion: this.#clientVersion,
        })
        : createRezClient({
          identity: this.#identity,
          uplinks: this.#uplinks,
          wsFactory: this.#wsFactory,
          expectedNodePublicKeyB64: this.#expectedNodePublicKeyB64,
          clientVersion: this.#clientVersion,
        });
      await client.connect();
      this.#client = client;
      return client;
    })();
    try {
      return await this.#connectPromise;
    } finally {
      this.#connectPromise = null;
    }
  }

  #armIdleTimer() {
    this.#clearIdleTimer();
    this.#idleTimer = setTimeout(() => {
      this.#idleTimer = null;
      // Fire-and-forget close; a failure to tear down cleanly is logged, and
      // the next execute() builds a fresh client either way.
      this.#teardownClient().catch((err) => {
        this.#logger.error("[AccountControlChannel] idle close failed: " + (err && err.message ? err.message : err));
      });
    }, this.#idleCloseMs);
  }

  #clearIdleTimer() {
    if (this.#idleTimer) {
      clearTimeout(this.#idleTimer);
      this.#idleTimer = null;
    }
  }

  async #teardownClient() {
    const client = this.#client;
    this.#client = null;
    if (!client) return;
    if (typeof client.disconnect === "function") {
      await client.disconnect();
    }
    if (typeof client.stop === "function") {
      await client.stop();
    }
  }
}
