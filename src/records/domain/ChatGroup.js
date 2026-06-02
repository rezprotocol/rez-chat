import { RRecord } from "@rezprotocol/sdk/client";
import { nonEmptyString, toFiniteNumber } from "./coerce.js";

export class ChatGroup extends RRecord {
  static type = "chat.group";

  constructor(raw = {}) {
    super();
    this.groupId = nonEmptyString(raw.groupId);
    this.ownerAccountId = nonEmptyString(raw.ownerAccountId);
    this.title = nonEmptyString(raw.title);
    this.threadId = nonEmptyString(raw.threadId);
    this.createdBy = nonEmptyString(raw.createdBy);
    // The invite this membership was joined via (acceptor side only). Lets a
    // rejected invite tear down exactly the group it created, bound to that one
    // invite rather than everything from the inviter. Empty for groups created
    // locally or joined before this field existed.
    this.joinedViaInviteId = nonEmptyString(raw.joinedViaInviteId);
    // Salt binding the creator to the groupId: groupId is derived from
    // hash(createdBy + ":" + creatorSalt). Carried (signed) in group invites
    // so an acceptor can VERIFY the claimed founder against the groupId itself
    // — a malicious inviter cannot forge a different createdBy (audit pass 5,
    // H2 closure). Empty for groups created before this field existed.
    this.creatorSalt = nonEmptyString(raw.creatorSalt);
    this.memberCount = Math.max(0, Math.trunc(toFiniteNumber(raw.memberCount, 0)));
    const createdAtMs = raw.createdAtMs == null ? null : toFiniteNumber(raw.createdAtMs, 0);
    this.createdAtMs = createdAtMs;
    this.updatedAtMs = raw.updatedAtMs == null ? createdAtMs : toFiniteNumber(raw.updatedAtMs, createdAtMs || 0);
    this._seal();
  }

  validate() {
    this.assert(this.groupId.length > 0, "ChatGroup requires groupId");
  }
}
