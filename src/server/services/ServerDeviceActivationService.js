import { BaseServerService } from "../base/BaseServerService.js";
import { DeviceActivationJournal, ACTIVATION_STATES } from "../device/DeviceActivationJournal.js";

/**
 * ServerDeviceActivationService (plans/DEVICE_ACTIVATION_PLAN.md) — the
 * NEW-DEVICE half of the activation transaction:
 *
 *     NEW → BOOTSTRAPPING → READY → ACTIVE
 *
 * with ONE invariant at its center: **bundle publication is the only
 * externally visible commit.** Everything before it can crash and the device
 * was never visible; everything after it is observable account state. This
 * service decides WHEN the existing publication machinery may run — it never
 * publishes anything itself except by calling the same `device-set`
 * directives the connect path always used.
 *
 * The provider learns nothing: activation state is account-layer knowledge
 * (I10); the node only ever observes the bundle appear.
 */
export class ServerDeviceActivationService extends BaseServerService {
  #journal;
  #clock;
  #committing;

  constructor({ bus, ownerAccountId, storageProvider, clock = () => Date.now(), logger = console } = {}) {
    super({ bus, ownerAccountId, logger });
    if (!storageProvider) throw new Error("ServerDeviceActivationService requires storageProvider");
    this.#journal = new DeviceActivationJournal({ storageProvider });
    this.#clock = typeof clock === "function" ? clock : () => Date.now();
    this.#committing = null;
    this._register("device-activation", "sync", () => this.syncWithNetwork());
    this._register("device-activation", "status", () => this.status());
    this._register("device-activation", "baselineComplete", (payload) => this.onBaselineComplete(payload || {}));
  }

  async status() {
    await this.#journal.hydrate();
    const record = this.#journal.get();
    return { state: record ? record.state : "ACTIVE", activationId: record ? record.activationId : "" };
  }

  #sdk() {
    return this.bus.runtime && this.bus.runtime.sdk ? this.bus.runtime.sdk : null;
  }

  #ownDeviceId() {
    const peerLinks = this.bus.runtime && this.bus.runtime.peerLinks ? this.bus.runtime.peerLinks : null;
    return peerLinks && typeof peerLinks.deviceId === "string" ? peerLinks.deviceId.trim() : "";
  }

  /** The activation transaction id = the ceremony's leaf certId, read from
   *  this device's own cert chain (the approver minted it; we hold it). */
  #activationIdFromIdentity() {
    const config = this.bus.config && typeof this.bus.config === "object" ? this.bus.config : {};
    const identity = config.identity && typeof config.identity === "object" ? config.identity : {};
    const chain = Array.isArray(identity.certChain) ? identity.certChain : [];
    const ownDeviceId = this.#ownDeviceId();
    for (const cert of chain) {
      if (cert && typeof cert === "object" && typeof cert.certId === "string"
        && (!ownDeviceId || cert.granteeDeviceId === ownDeviceId)) {
        return cert.certId;
      }
    }
    return chain.length > 0 && chain[0] && typeof chain[0].certId === "string" ? chain[0].certId : "";
  }

  /**
   * Reconcile the journal with the NETWORK'S observable truth at (re)connect,
   * and answer whether the connect path may publish. Called by
   * ServerRuntimeService for a DELEGATED identity on the fan-out path.
   *
   *   self in the home's device set  → the commit already happened (crash
   *                                    after publication, or pre-plan
   *                                    device): converge to ACTIVE by
   *                                    OBSERVATION — never re-decide.
   *   journal READY                  → crash between marker and publication:
   *                                    perform the commit now, exactly once.
   *   journal BOOTSTRAPPING          → not visible yet: publication DEFERRED;
   *                                    the baseline is requested every sync
   *                                    (liveness, never completeness).
   *   no journal + not in set        → a fresh post-plan enrollment booting
   *                                    for the first time: start
   *                                    BOOTSTRAPPING.
   *
   * @returns {Promise<{ publish: boolean, state: string }>}
   */
  async syncWithNetwork() {
    await this.#journal.hydrate();
    const sdk = this.#sdk();
    const ownDeviceId = this.#ownDeviceId();
    let selfInSet = false;
    if (sdk && sdk.devices && typeof sdk.devices.getAccountDeviceSet === "function" && ownDeviceId) {
      // Fail LOUD on unavailability: without the network's answer we cannot
      // decide visibility, and guessing either way is wrong.
      const { devices } = await sdk.devices.getAccountDeviceSet();
      selfInSet = Array.isArray(devices) && devices.some((d) => d && d.deviceId === ownDeviceId);
    }

    if (selfInSet) {
      await this.#journal.markActive();
      return { publish: true, state: ACTIVATION_STATES.ACTIVE };
    }

    const record = this.#journal.get();
    if (record && record.state === ACTIVATION_STATES.ACTIVE) {
      // Journal says ACTIVE but the bundle is not served (e.g. a home that
      // lost bundle state): publish — re-publication on reconnect is the
      // shipped behavior for active devices.
      return { publish: true, state: ACTIVATION_STATES.ACTIVE };
    }
    if (record && record.state === ACTIVATION_STATES.READY) {
      await this.#commit();
      return { publish: false, state: ACTIVATION_STATES.ACTIVE };
    }

    // BOOTSTRAPPING (fresh or resumed).
    const activationId = record ? record.activationId : this.#activationIdFromIdentity();
    if (!activationId) {
      // No cert chain ⇒ not an enrollment this plan governs (defensive):
      // behave as today.
      return { publish: true, state: "ACTIVE" };
    }
    await this.#journal.ensureBootstrapping({ activationId, nowMs: this.#clock() });
    // Request the baseline on EVERY bootstrapping sync — the first connect
    // included (P1.3-pre R1). The approver's push at ceremony-confirm cannot
    // land before this device's first boot: a durable home accepts deposits
    // only for CLAIMED inboxes (isHostedHere = the shared claim registry),
    // and the ceremony inbox is first claimed by THIS connect, moments before
    // this sync runs. So the deterministic delivery path is this request —
    // answered DIRECTLY at the inbox it names, throttled per activationId at
    // the answering sibling. LIVENESS ONLY, exactly like the stall re-ask it
    // generalizes: a request can never produce READY; only a valid, complete
    // baseline marker does.
    try {
      await this._call("account-state", "requestActivationBaseline", { activationId });
    } catch (err) {
      this.logger.warn("[ServerDeviceActivationService] baseline request failed (will retry next connect): "
        + (err && err.message ? err.message : err));
    }
    return { publish: false, state: ACTIVATION_STATES.BOOTSTRAPPING };
  }

  /**
   * A verified activation.baselineComplete marker was applied by the S14
   * pipeline. `seenBeforeLamport` is the origin's applied horizon BEFORE this
   * marker — the "all baseline events folded" check. A premature marker
   * (events still missing) parks: the stall path re-requests a fresh
   * baseline; completeness is never assumed.
   */
  async onBaselineComplete({ activationId, originDeviceId, horizonLamport, seenBeforeLamport } = {}) {
    await this.#journal.hydrate();
    const record = this.#journal.get();
    if (!record || record.state !== ACTIVATION_STATES.BOOTSTRAPPING) {
      return { applied: false, reason: "not-bootstrapping" };
    }
    if (typeof activationId !== "string" || activationId !== record.activationId) {
      // Bound to the TRANSACTION: a marker for a different activation attempt
      // completes nothing.
      return { applied: false, reason: "activation-mismatch" };
    }
    const horizon = Number.isInteger(horizonLamport) ? horizonLamport : NaN;
    const seenBefore = Number.isInteger(seenBeforeLamport) ? seenBeforeLamport : NaN;
    if (!Number.isInteger(horizon) || !Number.isInteger(seenBefore) || seenBefore < horizon) {
      this.logger.warn("[ServerDeviceActivationService] premature/invalid baseline marker (seen "
        + seenBefore + " < horizon " + horizon + "); staying BOOTSTRAPPING — the re-request path will heal");
      return { applied: false, reason: "premature-marker" };
    }
    await this.#journal.markReady({
      baselineOrigin: typeof originDeviceId === "string" ? originDeviceId : "",
      horizonLamport: horizon,
    });
    await this.#commit();
    return { applied: true };
  }

  /**
   * READY → ACTIVE: THE commit. Publishes this device's bundle and republishes
   * the account's device set to peers via the SAME directives the connect
   * path uses, then records ACTIVE. Serialized + idempotent: a concurrent or
   * repeated call rides the in-flight commit / no-ops after it.
   */
  async #commit() {
    if (this.#committing) return this.#committing;
    this.#committing = (async () => {
      try {
        await this._call("device-set", "publishOwnBundle", {});
        await this._call("device-set", "republishToAllPeers", {});
        await this.#journal.markActive();
        // AE-2: the freshly ACTIVE sibling's FIRST message convergence —
        // announce thread digests so the immutable fact logs sync (plan §3
        // trigger). Fire-and-forget: a failure never un-commits activation;
        // the reconnect trigger covers.
        if (this.bus.functions && this.bus.functions["sibling-sync"]) {
          this._call("sibling-sync", "syncAll", { force: true }).catch((err) => {
            this.logger.warn("[ServerDeviceActivationService] post-activation sibling sync failed (reconnect retries)",
              err && err.message ? err.message : err);
          });
        }
      } finally {
        this.#committing = null;
      }
    })();
    return this.#committing;
  }
}
