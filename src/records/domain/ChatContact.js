import { RRecord } from "@rezprotocol/sdk/client";
import { nonEmptyString, toFiniteNumber } from "./coerce.js";

// `known` is a name-bearing, relationship-less row: we know what this account
// is CALLED (e.g. a verified group co-member) but hold no 1:1 relationship with
// them. It is excluded from the active contact list and never gets a DM thread
// (isActiveContact gates on "active"). It exists so a peer's display name lives
// in ONE place keyed by accountId — the account table — resolved by one lookup,
// instead of being duplicated onto group membership rows. See
// feedback_explicit_over_clever_no_data_suppression.
export const RELATIONSHIP_STATES = Object.freeze(["known", "invited", "active", "blocked"]);
const VALID_RELATIONSHIP_STATES = new Set(RELATIONSHIP_STATES);

export function coerceRelationshipState(value, fallback = "active") {
  const text = nonEmptyString(value) || fallback;
  if (!VALID_RELATIONSHIP_STATES.has(text)) {
    throw new Error("relationshipState must be known|invited|active|blocked");
  }
  return text;
}

function coerceDisplayName(value) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (text.length > 64) {
    throw new Error("displayName must be 64 chars or fewer");
  }
  return text;
}

export class ChatContact extends RRecord {
  static type = "chat.contact";

  constructor(raw = {}) {
    super();
    this.accountId = nonEmptyString(raw.accountId);
    this.displayName = coerceDisplayName(raw.displayName);
    this.avatarFileHash = nonEmptyString(raw.avatarFileHash);
    this.relationshipState = coerceRelationshipState(raw.relationshipState, "active");
    const createdAtMs = toFiniteNumber(raw.createdAtMs, Date.now());
    this.createdAtMs = createdAtMs;
    this.updatedAtMs = toFiniteNumber(raw.updatedAtMs, createdAtMs);
    this.lastSeenAtMs = raw.lastSeenAtMs == null ? null : toFiniteNumber(raw.lastSeenAtMs, Date.now());
    this._seal();
  }

  validate() {
    this.assert(this.accountId.length > 0, "ChatContact requires accountId");
  }
}
