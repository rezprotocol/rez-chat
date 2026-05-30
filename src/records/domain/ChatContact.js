import { RRecord } from "@rezprotocol/sdk/client";
import { nonEmptyString, toFiniteNumber } from "./coerce.js";

export const RELATIONSHIP_STATES = Object.freeze(["invited", "active", "blocked"]);
const VALID_RELATIONSHIP_STATES = new Set(RELATIONSHIP_STATES);

export function coerceRelationshipState(value, fallback = "active") {
  const text = nonEmptyString(value) || fallback;
  if (!VALID_RELATIONSHIP_STATES.has(text)) {
    throw new Error("relationshipState must be invited|active|blocked");
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
