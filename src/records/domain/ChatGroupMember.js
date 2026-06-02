import { RRecord } from "@rezprotocol/sdk/client";
import { nonEmptyString, toFiniteNumber } from "./coerce.js";

// "creator" is the immutable group founder (group.createdBy): the highest
// role, above admin. It cannot be assigned via setRole, nor removed/demoted —
// enforced in ServerGroupsService. "admin" manages members; "member" is base.
export const GROUP_ROLES = Object.freeze(["creator", "admin", "member"]);
export const GROUP_MEMBER_STATES = Object.freeze(["active", "left", "removed"]);
const VALID_ROLES = new Set(GROUP_ROLES);
const VALID_STATES = new Set(GROUP_MEMBER_STATES);

export function coerceGroupRole(value, fallback = "member") {
  const role = nonEmptyString(value) || fallback;
  if (!VALID_ROLES.has(role)) throw new Error("role must be creator|admin|member");
  return role;
}

export function coerceGroupMemberState(value, fallback = "active") {
  const state = nonEmptyString(value) || fallback;
  if (!VALID_STATES.has(state)) throw new Error("state must be active|left|removed");
  return state;
}

export class ChatGroupMember extends RRecord {
  static type = "chat.groupMember";

  constructor(raw = {}) {
    super();
    this.ownerAccountId = nonEmptyString(raw.ownerAccountId);
    this.groupId = nonEmptyString(raw.groupId);
    this.accountId = nonEmptyString(raw.accountId);
    this.displayName = raw.displayName == null ? null : String(raw.displayName);
    this.role = coerceGroupRole(raw.role, "member");
    this.state = coerceGroupMemberState(raw.state, "active");
    const joinedAtMs = raw.joinedAtMs == null ? null : toFiniteNumber(raw.joinedAtMs, 0);
    this.joinedAtMs = joinedAtMs;
    this.updatedAtMs = raw.updatedAtMs == null ? joinedAtMs : toFiniteNumber(raw.updatedAtMs, joinedAtMs || 0);
    this._seal();
  }

  validate() {
    this.assert(this.groupId.length > 0, "ChatGroupMember requires groupId");
    this.assert(this.accountId.length > 0, "ChatGroupMember requires accountId");
  }
}
