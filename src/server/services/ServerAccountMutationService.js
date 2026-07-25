import { BaseServerService } from "../base/BaseServerService.js";

/**
 * ServerAccountMutationService — the chat-side driver for serialized device
 * add/revoke and revocation propagation (S2.5 S11, findings F4+F5).
 *
 * On `submit` it: reads the home's current authority epoch, builds + submits a
 * signed AccountDeviceMutationV1 (retrying on an optimistic-concurrency miss),
 * then PROPAGATES the result — first discharging the DURABLE authority-state
 * publication obligation the home enqueued inside the mutation's own transaction
 * (P1#3; the signed AccountAuthorityStateV1 is a public DurableRecordV2 owned by
 * B, so OFF-home peers learn revocations they cannot otherwise), then republishing
 * this account's device set to every peer at the NEW revision (so peers converge
 * on the new device set + reject the old one as a rollback) and dropping each
 * peer's cached set so the next resolve re-ingests at the higher revision.
 *
 * The authority-state publication is no longer built and put inline here — it is
 * drained through `authority-publication`/`drain` under a cluster-wide lease. The
 * per-peer device-set republish is still a best-effort inline loop; giving it its
 * own durable per-peer queue is a separate slice.
 *
 * `peerRevocationState` is the READER side: it fetches a peer's published
 * authority state (bounded-staleness cached) and projects it to the
 * `revocationState` the device-set opener consumes — null when the peer has no
 * revocations (byte-identical to the pre-S11 path).
 *
 * UNGATED (E6-independent): republish/resolve/authority-state are all outside the
 * per-device message fan-out gate, which stays closed until S12. When this
 * account runs no per-device sessions (no device key), every method no-ops.
 */
const AUTHORITY_STATE_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_STALE_RETRIES = 3;

export class ServerAccountMutationService extends BaseServerService {
  #clock;
  #authorityStateCache; // peerAccountId -> { revocationState, epoch, fetchedAtMs }
  #opCounter;

  constructor({ bus, ownerAccountId, clock = () => Date.now(), logger = console } = {}) {
    super({ bus, ownerAccountId, logger });
    this.#clock = typeof clock === "function" ? clock : () => Date.now();
    this.#authorityStateCache = new Map();
    this.#opCounter = 0;
    this._register("account-mutation", "submit", (payload) => this.submitMutation(payload || {}));
    this._register("account-mutation", "peerRevocationState", (payload) => this.getPeerRevocationState(payload || {}));
  }

  #sdk() {
    return this.bus.runtime && this.bus.runtime.sdk ? this.bus.runtime.sdk : null;
  }

  #peerLinks() {
    return this.bus.runtime && this.bus.runtime.peerLinks ? this.bus.runtime.peerLinks : null;
  }

  #durableRecords() {
    const sdk = this.#sdk();
    return sdk && sdk.durableRecords ? sdk.durableRecords : null;
  }

  /** True when this account runs per-device sessions and the mutation surface is present. */
  isEnabled() {
    const peerLinks = this.#peerLinks();
    const sdk = this.#sdk();
    return Boolean(
      peerLinks
        && typeof peerLinks.buildDeviceSetRecordForPeer === "function"
        && peerLinks.deviceId
        && sdk && sdk.devices && sdk.identity,
    );
  }

  #newOpId() {
    this.#opCounter += 1;
    const owner = this.ownerAccountId || "anon";
    return "opid:" + owner + ":" + this.#clock() + ":" + this.#opCounter;
  }

  /**
   * Submit a serialized device add/revoke, then propagate. Retries on an
   * optimistic-concurrency (stale expectedRevision) miss by re-reading the epoch.
   *
   * @param {object} opts
   * @param {"device.add"|"device.revoke"} opts.action
   * @param {object} opts.target — action-tagged target (see AccountDeviceMutationV1)
   * @param {"account"|"device"} [opts.signWith] — signing key (default account)
   * @returns {Promise<object|null>} the serializer result, or null when disabled.
   */
  async submitMutation({ action, target, signWith = "account" } = {}) {
    if (!this.isEnabled()) return null;
    const sdk = this.#sdk();

    let result = null;
    let attempt = 0;
    while (attempt < MAX_STALE_RETRIES) {
      const authority = await sdk.devices.getAuthorityState();
      const expectedRevision = authority && Number.isInteger(authority.epoch) ? authority.epoch : 0;
      const mutation = await sdk.identity.buildAccountDeviceMutation({
        opId: this.#newOpId(),
        expectedRevision,
        action,
        target,
        signWith,
        nowMs: this.#clock(),
      });
      result = await sdk.devices.submitDeviceMutation({ mutation });
      if (result && result.stale === true) {
        attempt += 1;
        continue;
      }
      break;
    }
    if (!result || result.stale === true) {
      throw new Error("ServerAccountMutationService.submitMutation: could not converge on the home revision after "
        + MAX_STALE_RETRIES + " attempts");
    }

    // COMMIT != PROPAGATION (P1#2 L4). The mutation has committed at the home by this point.
    // Propagation outcomes are REPORTED on the result, never thrown — a caller that treats a
    // propagation failure as "the mutation failed" would, in the device-link case, withhold a leaf
    // whose registration is already durably committed, orphaning it.
    const propagation = await this.#propagate(result);
    return { ...result, propagation };
  }

  // Publish the account authority-state record (now via the home's durable outbox), then
  // republish the device set to every peer at the new revision + drop caches.
  //
  // ORDER MATTERS (P1#3). The authority-state record is how OFF-HOME peers learn about a
  // revocation; the per-peer device-set republish is a convergence optimization. This used to run
  // peers FIRST and publish authority state last, so a single peer write failure threw before the
  // revocation was ever published — after the home revoke had already committed. Authority state
  // now goes first AND is durable, so neither a peer failure nor a crash here can lose it.
  async #propagate(result) {
    await this.#publishAuthorityState();

    const durableRecords = this.#durableRecords();
    const peerLinks = this.#peerLinks();
    if (!durableRecords) {
      throw new Error("ServerAccountMutationService requires sdk.durableRecords to propagate");
    }
    const revision = Number.isInteger(result.revision) && result.revision >= 1 ? result.revision : 1;
    const owner = this.ownerAccountId || peerLinks.ownerAccountId;

    // S12: republish the MULTI-device set (all active devices) when the home
    // serves the aggregated set; single-device otherwise (byte-compat).
    const accountDeviceSet = await this.#accountDeviceSetFromHome();
    const links = await peerLinks.peerLinkStorage.peerLinks.listByOwner(owner);
    const seen = new Set();
    const failedPeers = [];
    let publishedPeers = 0;
    for (const link of links) {
      const peer = link && typeof link.peerAccountId === "string" ? link.peerAccountId.trim() : "";
      if (!peer || seen.has(peer)) continue;
      seen.add(peer);
      // Per-peer isolation: one unreachable peer must not stop the others from converging, and
      // must not surface as a failed mutation. Failures are collected and reported, not swallowed
      // — a durable per-peer queue is its own slice.
      try {
        const built = await peerLinks.buildDeviceSetRecordForPeer({ peerAccountId: peer, revision, nowMs: this.#clock(), accountDeviceSet });
        await durableRecords.put({ record: built.record });
        this._call("device-set", "invalidate", { peerAccountId: peer });
        publishedPeers += 1;
      } catch (err) {
        const reason = err && err.message ? err.message : String(err);
        this.logger.error("[ServerAccountMutationService] device-set republish failed for " + peer + ": " + reason);
        failedPeers.push({ peerAccountId: peer, reason });
      }
    }
    return { peersPublished: publishedPeers, peersFailed: failedPeers };
  }

  /**
   * Discharge the authority-state publication obligation the home enqueued INSIDE this mutation's
   * own transaction (P1#3 leaf 5c). Replaces the former inline build-and-put here.
   *
   * The inline publish was fire-and-forget: if this process died, or the put failed, or a peer
   * write threw first, the revocation simply never reached off-home peers and nothing remembered
   * that it should have. The obligation is now a durable row the home enqueues atomically with the
   * fold, and this drains it under a cluster-wide lease.
   *
   * A drain failure does NOT fail the mutation. The mutation has COMMITTED at the home and the
   * obligation is durable — reporting failure here would tell the caller a committed revocation
   * did not happen, which is both false and the exact misreporting shape the P1#2 audit flagged.
   * It is logged instead, at a severity matching what it means, and a later drain retries it.
   */
  async #publishAuthorityState() {
    let outcome;
    try {
      outcome = await this._call("authority-publication", "drain", {});
    } catch (err) {
      this.logger.error(
        "[ServerAccountMutationService] authority-state publication FAILED after the home mutation"
          + " committed; the obligation remains durable and will be retried: "
          + (err && err.message ? err.message : err),
      );
      return;
    }
    if (!outcome || typeof outcome !== "object") {
      this.logger.error("[ServerAccountMutationService] authority-state drain returned no outcome");
      return;
    }
    // A committed mutation PROVES the node has a propagation outbox: the serializer builds or
    // validates one in its constructor and enqueues the obligation in the fold's own transaction,
    // so the mutation could not have committed without it. Either of these after a commit is
    // therefore contradictory wiring, not a deployment shape — and it means this account's
    // revocations will not reach off-home peers until it is fixed.
    if (outcome.enabled === false || outcome.stopped === "outbox-unavailable") {
      this.logger.error(
        "[ServerAccountMutationService] the home accepted a device mutation but its authority-state"
          + " outbox is unreachable from this client (stopped=" + outcome.stopped + ");"
          + " revocations will NOT reach off-home peers",
      );
      return;
    }
    if (Array.isArray(outcome.publishedEpochs) && outcome.publishedEpochs.length > 0) {
      return;
    }
    // Nothing published, but nothing broke: another device holds the lease, or the head is backing
    // off. The obligation stays outstanding and whoever holds the lease discharges it.
    this.logger.info(
      "[ServerAccountMutationService] authority-state publication deferred (stopped="
        + outcome.stopped + "); the obligation remains outstanding",
    );
  }

  /**
   * Resolve a peer's revocationState from its published authority-state record,
   * bounded-staleness cached. Returns null when the peer has published no
   * revocations (byte-identical to the pre-S11 device-set open path).
   *
   * @param {object} opts
   * @param {string} opts.peerAccountId
   * @param {boolean} [opts.forceRefresh]
   * @returns {Promise<{revokedCertIds:string[], minValidIssuedAtMs:number}|null>}
   */
  async getPeerRevocationState({ peerAccountId, forceRefresh = false } = {}) {
    if (!this.isEnabled()) return null;
    const peer = typeof peerAccountId === "string" ? peerAccountId.trim() : "";
    if (!peer) {
      throw new Error("ServerAccountMutationService.getPeerRevocationState requires peerAccountId");
    }
    const existing = this.#authorityStateCache.get(peer);
    if (!forceRefresh && existing && (this.#clock() - existing.fetchedAtMs) < AUTHORITY_STATE_CACHE_TTL_MS) {
      return existing.revocationState;
    }
    const durableRecords = this.#durableRecords();
    const peerLinks = this.#peerLinks();
    if (!durableRecords) {
      throw new Error("ServerAccountMutationService.getPeerRevocationState requires sdk.durableRecords");
    }
    const coords = await peerLinks.resolvePeerAuthorityStateCoordinates({ peerAccountId: peer });
    const record = await durableRecords.get(coords);
    if (!record) {
      // No published authority state ⇒ no revocations to enforce.
      this.#authorityStateCache.set(peer, { revocationState: null, epoch: 0, fetchedAtMs: this.#clock() });
      return null;
    }
    const opened = await peerLinks.openPeerAuthorityStateRecord({ peerAccountId: peer, record, nowMs: this.#clock() });
    const revocationState = this.#project(opened.revocationState);
    this.#authorityStateCache.set(peer, { revocationState, epoch: opened.epoch, fetchedAtMs: this.#clock() });
    return revocationState;
  }

  // The account's home-aggregated active device set (all self-published bundles),
  // or null when the home does not serve it (fs/desktop) or it is empty ⇒ the
  // single-device publish path.
  async #accountDeviceSetFromHome() {
    const sdk = this.#sdk();
    if (!sdk || !sdk.devices || typeof sdk.devices.getAccountDeviceSet !== "function") return null;
    try {
      const res = await sdk.devices.getAccountDeviceSet();
      const devices = res && Array.isArray(res.devices) ? res.devices : [];
      return devices.length > 0 ? devices : null;
    } catch (err) {
      if (this.logger && typeof this.logger.warn === "function") {
        this.logger.warn("[ServerAccountMutationService] getAccountDeviceSet unavailable; single-device republish", err && err.message ? err.message : err);
      }
      return null;
    }
  }

  // null-when-empty so a never-revoked peer is byte-identical to the primary path.
  #project(revocationState) {
    if (!revocationState || typeof revocationState !== "object") return null;
    const revokedCertIds = Array.isArray(revocationState.revokedCertIds) ? revocationState.revokedCertIds : [];
    const minValidIssuedAtMs = Number.isFinite(Number(revocationState.minValidIssuedAtMs)) ? Number(revocationState.minValidIssuedAtMs) : 0;
    if (revokedCertIds.length === 0 && minValidIssuedAtMs === 0) return null;
    return { revokedCertIds: [...revokedCertIds], minValidIssuedAtMs };
  }

  /** Drop a peer's cached authority state (e.g. on a newer epoch observed). */
  invalidate(peerAccountId) {
    const peer = typeof peerAccountId === "string" ? peerAccountId.trim() : "";
    if (peer) this.#authorityStateCache.delete(peer);
  }
}
