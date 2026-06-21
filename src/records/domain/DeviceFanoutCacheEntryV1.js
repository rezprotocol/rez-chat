import { RRecord } from "@rezprotocol/sdk/client";
import { nonEmptyString, toFiniteNumber } from "./coerce.js";

/**
 * DeviceFanoutCacheEntryV1 — the restart-surviving record of ONE sealed
 * per-(message, recipient device) ciphertext the sender holds so a retry
 * REPLAYS identical bytes instead of re-encrypting (which would advance the
 * send ratchet a second time and double-deliver). Persisted by
 * DeviceFanoutCacheStore, keyed by (ownerAccountId, peerAccountId, messageId,
 * peerDeviceId) so two messages / peers / devices can never collide — the
 * earlier ad-hoc object keyed only on messageId::deviceId, omitting the owner
 * and peer identity (Audit R4 #7).
 *
 * The sealed ciphertext rides as a base64 `payloadB64` plus its plain
 * `metadata` / `capChain` / `address` (all JSON-plain already), so the record
 * round-trips through the KV without inventing an un-typed shape.
 */
export class DeviceFanoutCacheEntryV1 extends RRecord {
  static type = "chat.deviceFanoutCacheEntry.v1";

  constructor(raw = {}) {
    super();
    this.ownerAccountId = nonEmptyString(raw.ownerAccountId);
    this.peerAccountId = nonEmptyString(raw.peerAccountId);
    this.peerDeviceId = nonEmptyString(raw.peerDeviceId);
    this.messageId = nonEmptyString(raw.messageId);
    this.payloadB64 = nonEmptyString(raw.payloadB64);
    this.metadata = raw.metadata && typeof raw.metadata === "object" ? raw.metadata : null;
    this.capChain = Array.isArray(raw.capChain) && raw.capChain.length > 0 ? raw.capChain : null;
    this.address = raw.address && typeof raw.address === "object" ? raw.address : null;
    this.deliveredOk = raw.deliveredOk === true;
    this.createdAtMs = toFiniteNumber(raw.createdAtMs, 0);
    this._seal();
  }

  validate() {
    this.assert(this.ownerAccountId.length > 0, "DeviceFanoutCacheEntryV1 requires ownerAccountId");
    this.assert(this.peerAccountId.length > 0, "DeviceFanoutCacheEntryV1 requires peerAccountId");
    this.assert(this.peerDeviceId.length > 0, "DeviceFanoutCacheEntryV1 requires peerDeviceId");
    this.assert(this.messageId.length > 0, "DeviceFanoutCacheEntryV1 requires messageId");
    this.assert(this.payloadB64.length > 0, "DeviceFanoutCacheEntryV1 requires payloadB64 ciphertext");
  }
}
