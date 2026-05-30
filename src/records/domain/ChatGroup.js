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
