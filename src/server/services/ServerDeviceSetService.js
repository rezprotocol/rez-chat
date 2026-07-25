import { BaseServerService } from "../base/BaseServerService.js";

/**
 * ServerDeviceSetService — the chat-side wiring of the per-device E2EE device set
 * (S2.5 Slice 5; folds in the deferred Slice 3 thin wiring).
 *
 * It owns the network + cache around the three network-free PeerLinkService
 * primitives built in Slice 3:
 *   - PUBLISH: build this account's sealed DeviceSetRecordV1 for a peer
 *     (`peerLinks.buildDeviceSetRecordForPeer`) and `sdk.durableRecords.put` it.
 *   - RESOLVE: recompute the peer's fetch coordinates
 *     (`peerLinks.resolvePeerDeviceSetCoordinates`, Slice 5 leaf 0),
 *     `sdk.durableRecords.get` the sealed record, and
 *     `peerLinks.ingestPeerDeviceSet` it — establishing one INITIATOR per-device
 *     session per peer device. Cached per peer (ingest is NOT idempotent — it
 *     mutates session state — so a cached set must not be re-ingested).
 *   - RESPOND: route an inbound device-set handshake to
 *     `peerLinks.completeDeviceSetResponder`.
 *
 * The E6 FAN-OUT GATE is NOT here: this service only publishes/resolves/answers
 * device sets. The sender deciding to fan a message out to >1 device is the
 * gated path (Slice 5 leaf 2 / flips at Slice 8). When this account runs no
 * per-device sessions (no device key — web / legacy vault), every method is a
 * no-op (`isEnabled()` false), so nothing changes for those paths.
 */
// How long a resolved device set is trusted before re-fetching (Audit P2). The
// old cache short-circuited BEFORE any fetch and never expired, so a peer's
// device add/remove/revoke could not propagate without the (uncalled) invalidate.
// A bounded TTL re-fetches; the SDK ingest is then idempotent per device and
// gated on the signed MONOTONIC revision (Audit R2 #2), so re-fetching an
// UNCHANGED set establishes nothing and a rolled-back (lower revision) set is
// rejected. (The earlier content-key compare hashed the sealed ciphertext, which
// carries a fresh nonce per publish — so every refresh looked "changed" and reset
// the initiator sessions while the responder kept the old one ⇒ desync.)
const DEVICE_SET_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export class ServerDeviceSetService extends BaseServerService {
  #clock;
  #resolved;

  constructor({ bus, ownerAccountId, clock = () => Date.now(), logger = console } = {}) {
    super({ bus, ownerAccountId, logger });
    this.#clock = typeof clock === "function" ? clock : () => Date.now();
    // peerAccountId -> { deviceSetRecord, established, fetchedAtMs, revision }
    this.#resolved = new Map();
    this._register("device-set", "publishForPeer", (payload) => this.publishForPeer(payload || {}));
    this._register("device-set", "resolveForPeer", (payload) => this.resolveForPeer(payload || {}));
    this._register("device-set", "completeResponder", (payload) => this.completeResponder(payload || {}));
    // S11: the account-mutation service drops a peer's cached set after a
    // republish so the next resolveForPeer re-ingests at the new revision.
    this._register("device-set", "invalidate", (payload) => {
      this.invalidate(payload && payload.peerAccountId);
      return { invalidated: true };
    });
    // S12: self-publish this device's bundle to the home + (re)publish the
    // account's multi-device set to every peer (driven by ServerRuntimeService
    // once the E6 gate is known open, and by the account-mutation service).
    this._register("device-set", "publishOwnBundle", (payload) => this.publishOwnDeviceBundle(payload || {}));
    this._register("device-set", "republishToAllPeers", (payload) => this.republishToAllPeers(payload || {}));
  }

  #peerLinks() {
    return this.bus.runtime && this.bus.runtime.peerLinks ? this.bus.runtime.peerLinks : null;
  }

  #durableRecords() {
    const sdk = this.bus.runtime && this.bus.runtime.sdk ? this.bus.runtime.sdk : null;
    return sdk && sdk.durableRecords ? sdk.durableRecords : null;
  }

  /**
   * True when this account runs per-device sessions (a device key is present on
   * the PeerLinkService). Web / legacy vaults have none ⇒ every method no-ops.
   */
  isEnabled() {
    const peerLinks = this.#peerLinks();
    return Boolean(
      peerLinks
        && typeof peerLinks.buildDeviceSetRecordForPeer === "function"
        && peerLinks.deviceId,
    );
  }

  /**
   * Publish this account's device set sealed to one peer onto the durable overlay.
   * @returns {Promise<{recordKind, recordId, publisherPublicKeyB64}|null>} null when disabled.
   */
  async publishForPeer({ peerAccountId, revision } = {}) {
    if (!this.isEnabled()) return null;
    const durableRecords = this.#durableRecords();
    if (!durableRecords) {
      throw new Error("ServerDeviceSetService.publishForPeer requires sdk.durableRecords");
    }
    // S12: when the home serves the account's aggregated device set, publish a
    // MULTI-device record enumerating all active devices; otherwise (fs/desktop or
    // an empty set) fall back to the byte-identical single-device path. The
    // revision is the account's authority epoch (S11) so peers never see a rollback.
    const accountDeviceSet = await this.#accountDeviceSetFromHome();
    const rev = Number.isInteger(revision) && revision >= 1 ? revision : await this.#currentRevision();
    const built = await this.#peerLinks().buildDeviceSetRecordForPeer({ peerAccountId, nowMs: this.#clock(), revision: rev, accountDeviceSet });
    await durableRecords.put({ record: built.record });
    return { recordKind: built.recordKind, recordId: built.recordId, publisherPublicKeyB64: built.publisherPublicKeyB64 };
  }

  /**
   * Self-publish THIS device's DevicePrekeyBundleV1 to the account home (S12) so
   * sibling devices can aggregate the account's full device set. No-op when
   * disabled or the home has no bundle store (SERVICE_UNAVAILABLE).
   * @returns {Promise<object|null>}
   */
  async publishOwnDeviceBundle({ nowMs } = {}) {
    if (!this.isEnabled()) return null;
    const sdk = this.bus.runtime && this.bus.runtime.sdk ? this.bus.runtime.sdk : null;
    const peerLinks = this.#peerLinks();
    if (!sdk || !sdk.devices || typeof sdk.devices.publishDeviceBundle !== "function"
        || typeof peerLinks.buildAndRetainAccountDeviceBundle !== "function") {
      return null;
    }
    const bundle = await peerLinks.buildAndRetainAccountDeviceBundle({ nowMs: nowMs || this.#clock() });
    return sdk.devices.publishDeviceBundle({ bundle });
  }

  /**
   * (Re)publish the account's device set to EVERY peer (S12) — e.g. after this
   * device's bundle changes or the E6 gate opens. Enumerates peer links by owner.
   * @returns {Promise<{ published: number }>}
   */
  async republishToAllPeers() {
    if (!this.isEnabled()) return { published: 0 };
    const peerLinks = this.#peerLinks();
    const owner = this.ownerAccountId || peerLinks.ownerAccountId;
    const links = await peerLinks.peerLinkStorage.peerLinks.listByOwner(owner);
    const seen = new Set();
    let published = 0;
    for (const link of links) {
      const peer = link && typeof link.peerAccountId === "string" ? link.peerAccountId.trim() : "";
      if (!peer || seen.has(peer)) continue;
      seen.add(peer);
      await this.publishForPeer({ peerAccountId: peer });
      published += 1;
    }
    return { published };
  }

  // The account's home-aggregated active device set (all self-published bundles),
  // or null when the home does not serve it (fs/desktop) or it is empty ⇒ the
  // single-device publish path.
  async #accountDeviceSetFromHome() {
    const sdk = this.bus.runtime && this.bus.runtime.sdk ? this.bus.runtime.sdk : null;
    if (!sdk || !sdk.devices || typeof sdk.devices.getAccountDeviceSet !== "function") return null;
    try {
      const res = await sdk.devices.getAccountDeviceSet();
      const devices = res && Array.isArray(res.devices) ? res.devices : [];
      return devices.length > 0 ? devices : null;
    } catch (err) {
      // A non-durable home answers SERVICE_UNAVAILABLE — fall back to single-device.
      if (this.logger && typeof this.logger.warn === "function") {
        this.logger.warn("[ServerDeviceSetService] getAccountDeviceSet unavailable; single-device publish", err && err.message ? err.message : err);
      }
      return null;
    }
  }

  // The account's current authority epoch (S11 revision), floored at 1 so the
  // DeviceSetRecordV1 revision is always a positive integer. 1 when the home does
  // not serve authority state (fs/desktop) — the byte-identical default.
  async #currentRevision() {
    const sdk = this.bus.runtime && this.bus.runtime.sdk ? this.bus.runtime.sdk : null;
    if (sdk && sdk.devices && typeof sdk.devices.getAuthorityState === "function") {
      try {
        const s = await sdk.devices.getAuthorityState();
        const e = s && Number.isInteger(s.epoch) ? s.epoch : 0;
        return Math.max(1, e);
      } catch (err) {
        return 1; // non-durable home ⇒ the single-device default revision
      }
    }
    return 1;
  }

  /**
   * Resolve a peer's device set: fetch it and establish per-device initiator
   * sessions. Cached per peer (ingest mutates session state — re-ingesting would
   * churn/replay sessions), so a repeated call returns the cached result without
   * a second fetch unless `forceRefresh`.
   * @returns {Promise<{deviceSetRecord, established, fetchedAtMs}|null>} null when disabled or absent.
   */
  async resolveForPeer({ peerAccountId, forceRefresh = false } = {}) {
    if (!this.isEnabled()) return null;
    const peer = typeof peerAccountId === "string" ? peerAccountId.trim() : "";
    if (!peer) {
      throw new Error("ServerDeviceSetService.resolveForPeer requires peerAccountId");
    }
    const existing = this.#resolved.get(peer);
    if (!forceRefresh && existing && (this.#clock() - existing.fetchedAtMs) < DEVICE_SET_CACHE_TTL_MS) {
      return existing;
    }
    const durableRecords = this.#durableRecords();
    if (!durableRecords) {
      throw new Error("ServerDeviceSetService.resolveForPeer requires sdk.durableRecords");
    }
    const coords = await this.#peerLinks().resolvePeerDeviceSetCoordinates({ peerAccountId: peer });
    const record = await durableRecords.get(coords);
    if (!record) {
      // The peer's set is gone — drop any stale cache so we stop fanning out to it.
      this.#resolved.delete(peer);
      return null;
    }
    // Ingest against the highest revision we've already accepted. The SDK opens +
    // verifies the signed inner DeviceSetRecordV1, REJECTS a lower revision as a
    // rollback, and establishes initiator sessions ONLY for devices we don't yet
    // have a session for (idempotent) — so an unchanged republish neither churns
    // sessions nor desyncs the responder (Audit R2 #2).
    const knownRevision = existing && Number.isInteger(existing.revision) ? existing.revision : 0;
    // Audit 2026-07-09 (F1): consult the peer's published authority state so a
    // REVOKED delegated signer's device set is rejected here, not silently
    // accepted. ServerAccountMutationService owns the bounded-staleness fetch +
    // projection; it returns null when the peer has published no revocations
    // (byte-identical to the pre-S11 open path). Co-registered with this service
    // (both gated on multiDeviceFanout), so the call is always available on the
    // fan-out path. A genuine lookup error propagates (fail-closed) rather than
    // being swallowed.
    const revocationState = await this._call("account-mutation", "peerRevocationState", { peerAccountId: peer });
    let result;
    try {
      result = await this.#peerLinks().ingestPeerDeviceSet({
        peerAccountId: peer,
        record,
        nowMs: this.#clock(),
        minRevision: knownRevision,
        revocationState,
      });
    } catch (err) {
      if (err && err.code === "DEVICE_SET_STALE_REVISION" && existing) {
        // A replayed / older set — keep the higher-revision one we already hold.
        existing.fetchedAtMs = this.#clock();
        if (this.logger && typeof this.logger.warn === "function") {
          this.logger.warn("[ServerDeviceSetService] ignored stale device-set revision for peer", peer,
            err && err.message ? err.message : err);
        }
        return existing;
      }
      throw err;
    }
    const revision = Number.isInteger(result.revision)
      ? result.revision
      : (result.deviceSetRecord && Number.isInteger(result.deviceSetRecord.revision) ? result.deviceSetRecord.revision : 0);
    const cached = {
      deviceSetRecord: result.deviceSetRecord,
      established: result.established,
      fetchedAtMs: this.#clock(),
      revision,
    };
    this.#resolved.set(peer, cached);
    return cached;
  }

  /**
   * Route an inbound device-set handshake (a peer ran X3DH against the bundle we
   * published to it) to the responder completion.
   */
  async completeResponder({ peerAccountId, peerDeviceId, handshakeData } = {}) {
    if (!this.isEnabled()) return null;
    return this.#peerLinks().completeDeviceSetResponder({ peerAccountId, peerDeviceId, handshakeData });
  }

  /**
   * Drop a peer's cached device set (e.g. after a revoke, or a newer revision was
   * observed) so the next resolveForPeer re-fetches + re-ingests.
   */
  invalidate(peerAccountId) {
    const peer = typeof peerAccountId === "string" ? peerAccountId.trim() : "";
    if (peer) this.#resolved.delete(peer);
  }
}
