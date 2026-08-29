const STORE_KEY = "chat-server:device-activation:v1";

export const ACTIVATION_STATES = Object.freeze({
  BOOTSTRAPPING: "BOOTSTRAPPING",
  READY: "READY",
  ACTIVE: "ACTIVE",
});

/**
 * DeviceActivationJournal (plans/DEVICE_ACTIVATION_PLAN.md) — the durable
 * record of which step of THIS device's activation transaction has completed,
 * mirroring what PendingCeremonyStore does for the approver side.
 *
 * It stores ONLY transaction-resume facts — never a shadow copy of the
 * DeviceSet, contacts, or authority (those live where they already live).
 * The network's observable truth (is this device's bundle published?) always
 * wins over the journal: a journal that says READY while the bundle is
 * already published converges to ACTIVE by OBSERVATION, never by
 * re-deciding.
 *
 * Migration rule (frozen): a device with NO journal is a pre-plan device —
 * it behaves exactly as today (visible ⇒ ACTIVE). The lifecycle applies
 * prospectively: a journal exists only for enrollments that start
 * BOOTSTRAPPING under this plan.
 */
export class DeviceActivationJournal {
  #kv;
  #record;
  #hydrated;

  constructor({ storageProvider } = {}) {
    if (!storageProvider || typeof storageProvider.getKeyValueStore !== "function") {
      throw new Error("DeviceActivationJournal requires storageProvider");
    }
    this.#kv = storageProvider.getKeyValueStore(null);
    this.#record = null;
    this.#hydrated = false;
  }

  async hydrate() {
    if (this.#hydrated) return;
    const stored = await this.#kv.get(STORE_KEY);
    this.#record = this.#normalize(stored);
    this.#hydrated = true;
  }

  /** null = no journal = pre-plan device (behaves as ACTIVE/today). */
  get() {
    this.#requireHydrated("get");
    return this.#record ? { ...this.#record } : null;
  }

  /**
   * Begin (or resume) the activation transaction for this enrollment.
   * Idempotent for the same activationId; a DIFFERENT activationId over an
   * unfinished journal is a hard inconsistency (two enrollments for one
   * device) — fail loud.
   */
  async ensureBootstrapping({ activationId, nowMs } = {}) {
    this.#requireHydrated("ensureBootstrapping");
    const id = typeof activationId === "string" ? activationId.trim() : "";
    if (!id) throw new Error("ensureBootstrapping requires activationId");
    if (this.#record) {
      if (this.#record.activationId !== id) {
        throw new Error("DeviceActivationJournal: journal holds activation " + this.#record.activationId
          + " but this boot presents " + id + " — two enrollments for one device");
      }
      return this.get();
    }
    await this.#persist({
      activationId: id,
      state: ACTIVATION_STATES.BOOTSTRAPPING,
      startedAtMs: Number(nowMs) || Date.now(),
    });
    return this.get();
  }

  /** BOOTSTRAPPING → READY, recording the attested baseline horizon. */
  async markReady({ baselineOrigin, horizonLamport } = {}) {
    this.#requireHydrated("markReady");
    if (!this.#record || this.#record.state !== ACTIVATION_STATES.BOOTSTRAPPING) {
      throw new Error("markReady: journal is not in BOOTSTRAPPING");
    }
    await this.#persist({
      ...this.#record,
      state: ACTIVATION_STATES.READY,
      baselineOrigin: typeof baselineOrigin === "string" ? baselineOrigin : "",
      horizonLamport: Number.isInteger(horizonLamport) ? horizonLamport : 0,
    });
    return this.get();
  }

  /**
   * → ACTIVE. Legal from READY (the commit) and from BOOTSTRAPPING
   * (network-observed convergence: the bundle is already published, so the
   * observable truth wins). Idempotent.
   */
  async markActive() {
    this.#requireHydrated("markActive");
    if (!this.#record) {
      // Pre-plan device converging: record the fact so future boots are cheap.
      await this.#persist({ activationId: "", state: ACTIVATION_STATES.ACTIVE, startedAtMs: Date.now() });
      return this.get();
    }
    if (this.#record.state === ACTIVATION_STATES.ACTIVE) return this.get();
    await this.#persist({ ...this.#record, state: ACTIVATION_STATES.ACTIVE });
    return this.get();
  }

  async #persist(record) {
    await this.#kv.set(STORE_KEY, record);
    this.#record = record;
  }

  #normalize(stored) {
    if (!stored || typeof stored !== "object") return null;
    const state = stored.state;
    if (state !== ACTIVATION_STATES.BOOTSTRAPPING && state !== ACTIVATION_STATES.READY
      && state !== ACTIVATION_STATES.ACTIVE) {
      return null;
    }
    return {
      activationId: typeof stored.activationId === "string" ? stored.activationId : "",
      state,
      startedAtMs: Number(stored.startedAtMs) || 0,
      baselineOrigin: typeof stored.baselineOrigin === "string" ? stored.baselineOrigin : "",
      horizonLamport: Number.isInteger(stored.horizonLamport) ? stored.horizonLamport : 0,
    };
  }

  #requireHydrated(method) {
    if (!this.#hydrated) throw new Error("DeviceActivationJournal." + method + " called before hydrate()");
  }
}
