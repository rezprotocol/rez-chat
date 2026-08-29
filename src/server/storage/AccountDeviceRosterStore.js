/**
 * AccountDeviceRosterStore (M4, plans/MOBILE_LIFECYCLE_ADAPTER_PLAN.md §7b/§7c
 * rulings) — the durable LAST-KNOWN snapshot of this account's ACTIVE device
 * set, as observed through an authenticated account-plane read of the home's
 * ACTIVE aggregate (`listActiveBundles` behind ACCOUNT_DEVICE_SET_GET).
 *
 * Deliberately boring (the ruling's shape): the store records KNOWN FACTS —
 * devices + routing inboxIds + the authority epoch the snapshot was taken at —
 * and nothing else. It does NOT fetch authority state and does NOT decide who
 * is revoked; a service composes `snapshot() + verified authority state →
 * effective roster`. S14 events must NEVER add a device here: they prove a
 * sibling existed when it sent, not that it is currently ACTIVE, and they
 * carry no routing inbox anyway.
 *
 * Replacement is FULL-SNAPSHOT: a device absent from the new snapshot is gone
 * (this is the account-plane half of the true→false transition; the
 * data-plane half is the epoch gate in the composing service).
 */
const STORE_KEY_PREFIX = "app:account-device-roster/";

export class AccountDeviceRosterStore {
  #kv;
  #ownerAccountId;
  #clock;
  #cached;
  #hydrated;

  constructor({ storageProvider, ownerAccountId, clock = () => Date.now() } = {}) {
    if (!storageProvider || typeof storageProvider.getKeyValueStore !== "function") {
      throw new Error("AccountDeviceRosterStore requires storageProvider.getKeyValueStore()");
    }
    if (typeof ownerAccountId !== "string" || ownerAccountId.trim().length === 0) {
      throw new Error("AccountDeviceRosterStore requires ownerAccountId");
    }
    this.#kv = storageProvider.getKeyValueStore(null);
    this.#ownerAccountId = ownerAccountId.trim();
    this.#clock = typeof clock === "function" ? clock : () => Date.now();
    this.#cached = null;
    this.#hydrated = false;
  }

  #key() {
    return STORE_KEY_PREFIX + this.#ownerAccountId;
  }

  async #hydrate() {
    if (this.#hydrated) return;
    const stored = await this.#kv.get(this.#key());
    this.#cached = this.#normalize(stored);
    this.#hydrated = true;
  }

  /**
   * Replace the durable snapshot wholesale. `devices` is the full ACTIVE set
   * as served by the authenticated aggregate read; `epoch` is the account's
   * authority epoch at snapshot time (0 when the home serves none).
   */
  async replaceSnapshot({ devices, epoch = 0, snapshotAtMs } = {}) {
    await this.#hydrate();
    if (!Array.isArray(devices)) {
      throw new Error("AccountDeviceRosterStore.replaceSnapshot requires devices[]");
    }
    const rows = [];
    const seen = new Set();
    for (const d of devices) {
      const deviceId = d && typeof d.deviceId === "string" ? d.deviceId.trim() : "";
      const inboxId = d && typeof d.inboxId === "string" ? d.inboxId.trim() : "";
      if (!deviceId || !inboxId) {
        throw new Error("AccountDeviceRosterStore.replaceSnapshot: every device needs deviceId + inboxId");
      }
      if (seen.has(deviceId)) continue;
      seen.add(deviceId);
      rows.push({ deviceId, inboxId });
    }
    const epochInt = Number(epoch);
    if (!Number.isInteger(epochInt) || epochInt < 0) {
      throw new Error("AccountDeviceRosterStore.replaceSnapshot: epoch must be a non-negative integer");
    }
    const at = Number(snapshotAtMs);
    const snapshot = {
      devices: rows,
      epoch: epochInt,
      snapshotAtMs: Number.isFinite(at) && at > 0 ? at : this.#clock(),
    };
    const previous = this.#cached;
    this.#cached = snapshot;
    try {
      await this.#kv.set(this.#key(), snapshot);
    } catch (err) {
      // The in-memory view must never claim a durability the store does not
      // have (same discipline as InboxClaimStore).
      this.#cached = previous;
      throw err;
    }
    return this.snapshotSync();
  }

  /**
   * Convenience for the account-plane hook: map the ACCOUNT_DEVICE_SET_GET
   * wire rows ({deviceId, prekeyVersion, bundle}) to roster rows — the
   * routing inboxId lives inside each device's signed prekey bundle.
   */
  async replaceFromAggregate({ devices, epoch = 0, snapshotAtMs } = {}) {
    if (!Array.isArray(devices)) {
      throw new Error("AccountDeviceRosterStore.replaceFromAggregate requires devices[]");
    }
    const rows = devices.map((d) => ({
      deviceId: d && typeof d.deviceId === "string" ? d.deviceId : "",
      inboxId: d && d.bundle && typeof d.bundle.inboxId === "string" ? d.bundle.inboxId : "",
    }));
    return this.replaceSnapshot({ devices: rows, epoch, snapshotAtMs });
  }

  /** The durable snapshot, or null when none was ever recorded. */
  async snapshot() {
    await this.#hydrate();
    return this.snapshotSync();
  }

  // Post-hydration synchronous read (composing services call this in hot
  // paths after an initial async snapshot()).
  snapshotSync() {
    if (!this.#cached) return null;
    return {
      devices: this.#cached.devices.map((d) => ({ ...d })),
      epoch: this.#cached.epoch,
      snapshotAtMs: this.#cached.snapshotAtMs,
    };
  }

  #normalize(stored) {
    if (!stored || typeof stored !== "object" || !Array.isArray(stored.devices)) return null;
    const rows = [];
    for (const d of stored.devices) {
      const deviceId = d && typeof d.deviceId === "string" ? d.deviceId.trim() : "";
      const inboxId = d && typeof d.inboxId === "string" ? d.inboxId.trim() : "";
      // A malformed row invalidates the whole snapshot: a PARTIAL roster
      // could silently omit a sibling forever (data suppression). Absent
      // fails toward "no roster → nothing sent" — the safe direction.
      if (!deviceId || !inboxId) return null;
      rows.push({ deviceId, inboxId });
    }
    const epoch = Number(stored.epoch);
    const snapshotAtMs = Number(stored.snapshotAtMs);
    if (!Number.isInteger(epoch) || epoch < 0) return null;
    if (!Number.isFinite(snapshotAtMs) || snapshotAtMs <= 0) return null;
    return { devices: rows, epoch, snapshotAtMs };
  }
}
