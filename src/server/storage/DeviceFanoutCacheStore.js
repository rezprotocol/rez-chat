import { createHash } from "node:crypto";
import { bytesToBase64, base64ToBytes } from "@rezprotocol/core";

export const DEVICE_FANOUT_PREFIX = "app:devicefanout/";

// A retry of a failed per-device send must REPLAY the identical sealed bytes —
// re-encrypting advances the sender's send-ratchet a second time, duplicating
// delivery and burning the recipient's skipped-key tolerance (Audit R2 #4). The
// in-memory cache that enforced this was lost on sender restart, so a recovery
// re-send after a crash re-encrypted everything (Audit R3 #4). 72h matches the
// node's outbound-queue retention, so a legitimate retry never finds the entry
// expired; past that the message is terminally failed and a fresh seal is fine.
const DEFAULT_TTL_MS = 72 * 60 * 60 * 1000;

function slotKey(cacheKey) {
  const h = createHash("sha256").update(String(cacheKey)).digest("base64url");
  return DEVICE_FANOUT_PREFIX + h.slice(0, 43);
}

/**
 * DeviceFanoutCacheStore — durable per-(messageId, peerDeviceId) sealed
 * ciphertext, so a send retry (including one after a sender restart) replays
 * identical bytes instead of re-encrypting.
 *
 * The sealed value produced by sdk.sealForPeerDevice is already plain data —
 * `{ object: { payloadBytes (Uint8Array), metadata, capChain }, address }` —
 * so it round-trips through the KV by base64-encoding only the payload bytes;
 * metadata / capChain / address are JSON-plain.
 *
 * Entries carry `deliveredOk`: once a device is delivered (or the node queued
 * it durably), a later retry of the same messageId must skip that device rather
 * than re-dispatch (re-dispatching identical ratchet bytes double-advances the
 * recipient's receive ratchet). TTL is enforced AT LOOKUP (an aged entry reads
 * as a miss and is evicted), not only at capacity — and `prune()` sweeps the
 * KV so entries that are never read again cannot accumulate.
 */
export class DeviceFanoutCacheStore {
  #kv;
  #clock;
  #ttlMs;

  constructor({ storageProvider, clock = () => Date.now(), ttlMs = DEFAULT_TTL_MS } = {}) {
    if (!storageProvider || typeof storageProvider.getKeyValueStore !== "function") {
      throw new Error("DeviceFanoutCacheStore requires storageProvider.getKeyValueStore()");
    }
    this.#kv = storageProvider.getKeyValueStore(null);
    this.#clock = clock;
    this.#ttlMs = ttlMs;
  }

  #serialize(sealed) {
    const object = sealed && sealed.object ? sealed.object : {};
    return {
      payloadB64: bytesToBase64(object.payloadBytes),
      metadata: object.metadata && typeof object.metadata === "object" ? object.metadata : null,
      capChain: Array.isArray(object.capChain) ? object.capChain : null,
      address: sealed && sealed.address ? sealed.address : null,
    };
  }

  #deserialize(raw) {
    return {
      object: {
        payloadBytes: base64ToBytes(raw.payloadB64),
        metadata: raw.metadata && typeof raw.metadata === "object" ? raw.metadata : {},
        capChain: Array.isArray(raw.capChain) && raw.capChain.length > 0 ? raw.capChain : null,
      },
      address: raw.address,
    };
  }

  /**
   * @param {string} cacheKey - `${messageId}::${peerDeviceId}`
   * @returns {Promise<{ sealed: object, deliveredOk: boolean }|null>}
   */
  async get(cacheKey) {
    if (!cacheKey) return null;
    const key = slotKey(cacheKey);
    const raw = await Promise.resolve(this.#kv.get(key));
    if (!raw || typeof raw !== "object" || typeof raw.payloadB64 !== "string") return null;
    if (this.#clock() - Number(raw.createdAtMs || 0) > this.#ttlMs) {
      // TTL at lookup: an aged entry reads as a miss and is evicted in place.
      await Promise.resolve(this.#kv.delete(key));
      return null;
    }
    return { sealed: this.#deserialize(raw), deliveredOk: raw.deliveredOk === true };
  }

  /**
   * Persist a freshly-sealed device ciphertext (deliveredOk = false).
   * @param {string} cacheKey
   * @param {object} sealed - { object, address } from sealForPeerDevice
   */
  async put(cacheKey, sealed) {
    if (!cacheKey) return;
    const value = this.#serialize(sealed);
    value.deliveredOk = false;
    value.createdAtMs = this.#clock();
    await Promise.resolve(this.#kv.set(slotKey(cacheKey), value));
  }

  /**
   * Mark a device delivered so any future retry of this messageId skips it.
   * No-op if the entry is gone (already pruned/expired).
   * @param {string} cacheKey
   */
  async markDelivered(cacheKey) {
    if (!cacheKey) return;
    const key = slotKey(cacheKey);
    const raw = await Promise.resolve(this.#kv.get(key));
    if (!raw || typeof raw !== "object") return;
    raw.deliveredOk = true;
    await Promise.resolve(this.#kv.set(key, raw));
  }

  /**
   * Sweep expired entries so ones that are never read again cannot accumulate.
   * Best-effort; called on service start.
   * @returns {Promise<number>} evicted count
   */
  async prune() {
    const keys = await Promise.resolve(this.#kv.keys(DEVICE_FANOUT_PREFIX));
    if (!Array.isArray(keys)) return 0;
    const now = this.#clock();
    let evicted = 0;
    for (const key of keys) {
      const raw = await Promise.resolve(this.#kv.get(key));
      if (!raw || typeof raw !== "object" || now - Number(raw.createdAtMs || 0) > this.#ttlMs) {
        await Promise.resolve(this.#kv.delete(key));
        evicted += 1;
      }
    }
    return evicted;
  }
}
