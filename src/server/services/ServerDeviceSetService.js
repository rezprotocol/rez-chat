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
export class ServerDeviceSetService extends BaseServerService {
  #clock;
  #resolved;

  constructor({ bus, ownerAccountId, clock = () => Date.now(), logger = console } = {}) {
    super({ bus, ownerAccountId, logger });
    this.#clock = typeof clock === "function" ? clock : () => Date.now();
    // peerAccountId -> { deviceSetRecord, established, fetchedAtMs }
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
    if (!forceRefresh && this.#resolved.has(peer)) {
      return this.#resolved.get(peer);
    }
    const durableRecords = this.#durableRecords();
    if (!durableRecords) {
      throw new Error("ServerDeviceSetService.resolveForPeer requires sdk.durableRecords");
    }
    const coords = await this.#peerLinks().resolvePeerDeviceSetCoordinates({ peerAccountId: peer });
    const record = await durableRecords.get(coords);
    if (!record) {
      return null;
    }
    const result = await this.#peerLinks().ingestPeerDeviceSet({ peerAccountId: peer, record, nowMs: this.#clock() });
    const cached = {
      deviceSetRecord: result.deviceSetRecord,
      established: result.established,
      fetchedAtMs: this.#clock(),
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
