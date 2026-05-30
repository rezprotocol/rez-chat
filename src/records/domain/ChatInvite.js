import { RRecord } from "@rezprotocol/sdk/client";
import { nonEmptyString, toFiniteNumber } from "./coerce.js";

export const INVITE_KINDS = Object.freeze(["direct", "group"]);
const VALID_INVITE_KINDS = new Set(INVITE_KINDS);

export const INVITE_STATUSES = Object.freeze(["active", "consumed", "revoked", "expired"]);
const VALID_INVITE_STATUSES = new Set(INVITE_STATUSES);

function coerceInviteKind(value, fallback = "direct") {
  if (value == null || value === "") return fallback;
  const text = String(value).toLowerCase().trim();
  if (text === "") return fallback;
  if (!VALID_INVITE_KINDS.has(text)) {
    throw new Error(`ChatInvite.kind must be one of ${INVITE_KINDS.join("|")}, got '${text}'`);
  }
  return text;
}

function coerceInviteStatus(value, fallback = "active") {
  if (value == null || value === "") return fallback;
  const text = String(value).toLowerCase().trim();
  if (text === "") return fallback;
  if (!VALID_INVITE_STATUSES.has(text)) {
    throw new Error(`ChatInvite.status must be one of ${INVITE_STATUSES.join("|")}, got '${text}'`);
  }
  return text;
}

export class ChatInvite extends RRecord {
  static type = "chat.invite";

  constructor(raw = {}) {
    super();
    // inviteId and inviteCode are DISTINCT values, not aliases:
    //   inviteId   — opaque binary identifier used in the peer-link protocol
    //   inviteCode — Base64url-encoded user-facing form embedding inviteId
    // Both are kept on the record; at least one must be set (validate).
    this.inviteId = nonEmptyString(raw.inviteId);
    this.inviteCode = nonEmptyString(raw.inviteCode);
    this.kind = coerceInviteKind(raw.kind);
    this.groupId = nonEmptyString(raw.groupId);
    this.expiresAtMs = raw.expiresAtMs == null ? null : toFiniteNumber(raw.expiresAtMs, 0);
    this.maxUses = Math.max(1, Math.trunc(toFiniteNumber(raw.maxUses, 1)));
    this.uses = Math.max(0, Math.trunc(toFiniteNumber(raw.uses, 0)));
    this.status = coerceInviteStatus(raw.status);
    this._seal();
  }

  validate() {
    this.assert(this.inviteCode.length > 0 || this.inviteId.length > 0,
      "ChatInvite requires at least one of inviteCode or inviteId");
  }
}
