import {
  PendingCeremonyRecordV1,
  PENDING_CEREMONY_STATES,
  isAllowedCeremonyTransition,
} from "../../records/domain/PendingCeremonyRecordV1.js";

export const PENDING_CEREMONY_PREFIX = "app:pendingceremony/";

function slotKey(deviceId) {
  return PENDING_CEREMONY_PREFIX + deviceId;
}

/**
 * PendingCeremonyStore — durable persist-and-resume state for device-link registrations (P1#2a).
 *
 * Keyed by deviceId: one linked device has exactly one registration to resume. The store owns
 * three rules that exist because a RELEASED leaf is real authority off-home, and therefore
 * nothing here may ever be quietly forgotten:
 *
 *   1. NO CLOBBER. Creating a pending record for a device that already has a non-terminal one
 *      fails. Overwriting would orphan the first registration — its leaf may already be released
 *      and revocable only by the certId this record holds.
 *   2. FORWARD-ONLY STATE. pending → published → confirmed, or pending → expired. Anything else
 *      (a backwards step, an unknown state, confirming something never published) throws.
 *   3. DELETION REQUIRES A COMMITTED REVOKE. Expiry does NOT delete: an expired registration whose
 *      leaf was released is exactly the case that still needs revoking, so dropping the record
 *      would destroy the certId needed to revoke it. `deleteAfterRevoke` is the only removal path
 *      and it demands explicit proof-of-revoke from the caller.
 *
 * At-rest encryption is inherited from the chat server's EncryptedKeyValueStore (see
 * PendingCeremonyRecordV1) — this class adds no crypto of its own.
 */
export class PendingCeremonyStore {
  #kv;
  #clock;

  constructor({ storageProvider, clock = () => Date.now() } = {}) {
    if (!storageProvider || typeof storageProvider.getKeyValueStore !== "function") {
      throw new Error("PendingCeremonyStore requires storageProvider.getKeyValueStore()");
    }
    this.#kv = storageProvider.getKeyValueStore(null);
    this.#clock = typeof clock === "function" ? clock : () => Date.now();
  }

  #requireDeviceId(deviceId, op) {
    const id = typeof deviceId === "string" ? deviceId.trim() : "";
    if (id.length === 0) {
      throw new Error("PendingCeremonyStore." + op + " requires a deviceId");
    }
    return id;
  }

  /** @returns {Promise<PendingCeremonyRecordV1|null>} */
  async get(deviceId) {
    const id = this.#requireDeviceId(deviceId, "get");
    const raw = await Promise.resolve(this.#kv.get(slotKey(id)));
    if (!raw || typeof raw !== "object") return null;
    // A malformed row throws out of the record constructor rather than reading as "no pending
    // registration" — absence and corruption must not look alike here of all places.
    return new PendingCeremonyRecordV1(raw);
  }

  /**
   * Persist a NEW registration in state `pending`, BEFORE device.add is submitted.
   *
   * @param {object} fields — everything PendingCeremonyRecordV1 requires except state/timestamps
   * @returns {Promise<PendingCeremonyRecordV1>}
   * @throws if this device already has a registration that has not reached a terminal state
   */
  async createPending(fields = {}) {
    const id = this.#requireDeviceId(fields.deviceId, "createPending");
    const existing = await this.get(id);
    if (existing !== null
        && existing.state !== PENDING_CEREMONY_STATES.CONFIRMED
        && existing.state !== PENDING_CEREMONY_STATES.EXPIRED) {
      // Rule 1. The in-flight registration may already have released its leaf; replacing it here
      // would lose the certId that revoking it depends on.
      throw new Error(
        "PendingCeremonyStore.createPending: device " + id + " already has a " + existing.state
          + " registration — resume or revoke it before starting another",
      );
    }
    const at = this.#clock();
    const record = new PendingCeremonyRecordV1({
      ...fields,
      deviceId: id,
      state: PENDING_CEREMONY_STATES.PENDING,
      createdAtMs: at,
      updatedAtMs: at,
    });
    await Promise.resolve(this.#kv.set(slotKey(id), record.toJSON()));
    return record;
  }

  /**
   * Advance the state. Forward-only; the rest of the record is immutable.
   * @returns {Promise<PendingCeremonyRecordV1>}
   */
  async #transition(deviceId, to, op) {
    const id = this.#requireDeviceId(deviceId, op);
    const existing = await this.get(id);
    if (existing === null) {
      throw new Error("PendingCeremonyStore." + op + ": no registration for device " + id);
    }
    if (!isAllowedCeremonyTransition(existing.state, to)) {
      throw new Error(
        "PendingCeremonyStore." + op + ": cannot move device " + id
          + " from " + existing.state + " to " + to,
      );
    }
    const next = new PendingCeremonyRecordV1({
      ...existing.toJSON(),
      state: to,
      updatedAtMs: this.#clock(),
    });
    await Promise.resolve(this.#kv.set(slotKey(id), next.toJSON()));
    return next;
  }

  /** The stored sealed response has been published (idempotently) to the rendezvous coordinate. */
  async markPublished(deviceId) {
    return this.#transition(deviceId, PENDING_CEREMONY_STATES.PUBLISHED, "markPublished");
  }

  /**
   * The new device returned its confirmation tag. ACKNOWLEDGMENT ONLY — authority was live from
   * the moment the leaf was released, so this neither grants nor withholds anything.
   */
  async markConfirmed(deviceId) {
    return this.#transition(deviceId, PENDING_CEREMONY_STATES.CONFIRMED, "markConfirmed");
  }

  /**
   * The ceremony passed its deadline without completing. The record REMAINS — an expired
   * registration is precisely the one that may still need a compensating revoke.
   */
  async markExpired(deviceId) {
    return this.#transition(deviceId, PENDING_CEREMONY_STATES.EXPIRED, "markExpired");
  }

  /** Every registration still owing a publication — the resume work-list after a crash. */
  async listResumable() {
    const keys = await Promise.resolve(this.#kv.keys(PENDING_CEREMONY_PREFIX));
    const out = [];
    for (const key of Array.isArray(keys) ? keys : []) {
      const raw = await Promise.resolve(this.#kv.get(key));
      if (!raw || typeof raw !== "object") continue;
      const record = new PendingCeremonyRecordV1(raw);
      if (record.needsPublication()) out.push(record);
    }
    return out;
  }

  /** Registrations past their deadline that have not been published — candidates for markExpired. */
  async listExpirable() {
    const now = this.#clock();
    const resumable = await this.listResumable();
    return resumable.filter((r) => r.expiresAtMs <= now);
  }

  /**
   * The ONLY deletion path. A released leaf is real authority off-home, so the record may be
   * dropped only once a REAL revoke is durably committed (cert revoked + tombstone + epoch bump +
   * propagation enqueued). The caller must say so explicitly — there is deliberately no
   * convenience delete, and no expiry-driven cleanup.
   *
   * @param {string} deviceId
   * @param {{ revokeCommitted: boolean, revokedCertId: string }} proof
   */
  async deleteAfterRevoke(deviceId, { revokeCommitted, revokedCertId } = {}) {
    const id = this.#requireDeviceId(deviceId, "deleteAfterRevoke");
    if (revokeCommitted !== true) {
      throw new Error(
        "PendingCeremonyStore.deleteAfterRevoke: refusing to delete device " + id
          + " without a committed revoke — the record holds the certId that revoking it depends on",
      );
    }
    const existing = await this.get(id);
    if (existing === null) return false;
    if (typeof revokedCertId !== "string" || revokedCertId !== existing.certId) {
      // Deleting on the strength of a revoke for some OTHER cert would drop a live registration.
      throw new Error(
        "PendingCeremonyStore.deleteAfterRevoke: the committed revoke does not name this"
          + " registration's certId",
      );
    }
    await Promise.resolve(this.#kv.delete(slotKey(id)));
    return true;
  }
}
