import { RRecord } from "@rezprotocol/sdk/client";
import { ChatGroupMember } from "../domain/ChatGroupMember.js";
import { nonEmptyString } from "../domain/coerce.js";

export class GroupMembersUpdatedEvent extends RRecord {
  static type = "chat.evt.group_members_updated";

  constructor(raw = {}) {
    super();
    this.groupId = nonEmptyString(raw.groupId);
    const items = Array.isArray(raw.members) ? raw.members : [];
    this.members = Object.freeze(items.map((m) => (
      m instanceof ChatGroupMember && m.groupId === this.groupId
        ? m
        : new ChatGroupMember({ ...(m && m.toJSON ? m.toJSON() : m), groupId: this.groupId })
    )));
    this._seal();
  }

  validate() {
    this.assert(this.groupId.length > 0, "GroupMembersUpdatedEvent: groupId required");
  }
}
