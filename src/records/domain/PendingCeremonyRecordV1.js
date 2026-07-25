import { RRecord } from "@rezprotocol/sdk/client";
import { nonEmptyString, toFiniteNumber } from "./coerce.js";

/** The forward-only lifecycle of a device-link registration (P1#2a). */
export const PENDING_CEREMONY_STATES = Object.freeze({
  PENDING: "pending",
  PUBLISHED: "published",
  CONFIRMED: "confirmed",
  EXPIRED: "expired",
});

// Which states may follow which. `confirmed` and `expired` are terminal for the STATE — not for
// the RECORD, which outlives both (see the deletion rule in PendingCeremonyStore).
const ALLOWED_TRANSITIONS = Object.freeze({
  pending: Object.freeze(["published", "expired"]),
  published: Object.freeze(["confirmed"]),
  confirmed: Object.freeze([]),
  expired: Object.freeze([]),
});

export function isAllowedCeremonyTransition(from, to) {
  const next = Object.prototype.hasOwnProperty.call(ALLOWED_TRANSITIONS, from) ? ALLOWED_TRANSITIONS[from] : null;
  if (next === null) return false;
  return next.includes(to);
}

/**
 * PendingCeremonyRecordV1 — the durable, resumable state of ONE device-link registration
 * (P1#2a, persist-and-resume ACTIVE registration).
 *
 * WHY THIS EXISTS. A device.add is authoritative the moment the leaf cert is released: off-home
 * verifiers see a valid leaf and the home's terminal predicate only rejects revoked/tombstoned
 * devices, so there is no such thing as a "tentative" release. Recovery therefore cannot mean
 * "retry the ceremony" — a fresh ceremony mints a DIFFERENT certId (the id derives from a body
 * that includes issuedAtMs/expiresAtMs), so retrying never converges on the registration that
 * already committed. Recovery has to mean RESUME: replay the EXACT publication that was already
 * prepared.
 *
 * So the approver builds and SEALS the ceremony response BEFORE submitting device.add, persists
 * it here in state `pending`, and only publishes it after the registration commit returns. A
 * crash anywhere in between is recoverable by re-publishing these exact stored bytes.
 *
 * AT REST. This record holds the confirmation material and the sealed response; it is written
 * through the chat server's key-value store, which bootstrapChatServer wraps in
 * EncryptedKeyValueStore (AES-256-GCM under an HKDF-derived key). Encryption is INHERITED from
 * that one mechanism — this record deliberately does not add a second crypto layer.
 *
 * IMMUTABLE CONTENTS. Everything except `state`/`updatedAtMs` is fixed at creation: mutating the
 * leaf, the sealed response, or the transcript binding after the fact would break the "resume the
 * exact publication" guarantee that is the whole point.
 */
export class PendingCeremonyRecordV1 extends RRecord {
  static type = "chat.pendingCeremony.v1";

  constructor(raw = {}) {
    super();
    // Identity of the device being linked, and the inbox the ceremony assigned it.
    this.deviceId = nonEmptyString(raw.deviceId);
    this.inboxId = nonEmptyString(raw.inboxId);
    // The minted leaf cert, verbatim. Its certId is what the home binds and what a revoke must
    // later name, so it is retained exactly as released rather than re-derived.
    this.leafCert = raw.leafCert && typeof raw.leafCert === "object" && !Array.isArray(raw.leafCert)
      ? raw.leafCert
      : null;
    this.certId = nonEmptyString(raw.certId);
    // The SEALED ceremony response, built but not yet published. Republishing these exact bytes
    // is what makes a crash between commit and publish recoverable.
    this.sealedResponse = raw.sealedResponse && typeof raw.sealedResponse === "object" && !Array.isArray(raw.sealedResponse)
      ? raw.sealedResponse
      : null;
    // Transcript binding — which request this response answers.
    this.thRequestB64 = nonEmptyString(raw.thRequestB64);
    this.thResponseB64 = nonEmptyString(raw.thResponseB64);
    // The confirmation tag the new device is expected to return. Acknowledgment ONLY: it does not
    // gate authority, because the leaf was already live at release.
    this.confirmTagB64 = nonEmptyString(raw.confirmTagB64);
    this.state = nonEmptyString(raw.state);
    this.expiresAtMs = toFiniteNumber(raw.expiresAtMs, 0);
    this.createdAtMs = toFiniteNumber(raw.createdAtMs, 0);
    this.updatedAtMs = toFiniteNumber(raw.updatedAtMs, 0);
    this._seal();
  }

  validate() {
    this.assert(this.deviceId.length > 0, "PendingCeremonyRecordV1 requires deviceId");
    this.assert(this.inboxId.length > 0, "PendingCeremonyRecordV1 requires inboxId");
    this.assert(this.certId.length > 0, "PendingCeremonyRecordV1 requires certId");
    this.assert(this.leafCert !== null, "PendingCeremonyRecordV1 requires the minted leafCert");
    this.assert(this.sealedResponse !== null, "PendingCeremonyRecordV1 requires the sealed response to resume from");
    this.assert(this.thRequestB64.length > 0, "PendingCeremonyRecordV1 requires thRequestB64");
    this.assert(this.thResponseB64.length > 0, "PendingCeremonyRecordV1 requires thResponseB64");
    this.assert(this.confirmTagB64.length > 0, "PendingCeremonyRecordV1 requires confirmTagB64");
    this.assert(
      Object.values(PENDING_CEREMONY_STATES).includes(this.state),
      "PendingCeremonyRecordV1 state must be one of: " + Object.values(PENDING_CEREMONY_STATES).join(", "),
    );
    this.assert(this.expiresAtMs > 0, "PendingCeremonyRecordV1 requires a positive expiresAtMs");
    this.assert(this.createdAtMs > 0, "PendingCeremonyRecordV1 requires a positive createdAtMs");
  }

  /** True while this registration still owes a publication (i.e. resume work remains). */
  needsPublication() {
    return this.state === PENDING_CEREMONY_STATES.PENDING;
  }
}
