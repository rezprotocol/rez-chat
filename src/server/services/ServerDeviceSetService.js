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
  async publishForPeer({ peerAccountId } = {}) {
    if (!this.isEnabled()) return null;
    const durableRecords = this.#durableRecords();
    if (!durableRecords) {
      throw new Error("ServerDeviceSetService.publishForPeer requires sdk.durableRecords");
    }
    const built = await this.#peerLinks().buildDeviceSetRecordForPeer({ peerAccountId, nowMs: this.#clock() });
    await durableRecords.put({ record: built.record });
    return { recordKind: built.recordKind, recordId: built.recordId, publisherPublicKeyB64: built.publisherPublicKeyB64 };
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
    let result;
    try {
      result = await this.#peerLinks().ingestPeerDeviceSet({
        peerAccountId: peer,
        record,
        nowMs: this.#clock(),
        minRevision: knownRevision,
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
