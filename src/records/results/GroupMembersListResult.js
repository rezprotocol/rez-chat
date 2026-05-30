import { SchemaRecord } from "../SchemaRecord.js";
import { ChatGroupMember } from "../domain/ChatGroupMember.js";

export class GroupMembersListResult extends SchemaRecord {
  static type = "chat.result.group_members_list";
  static schema = {
    items: { type: "array", record: ChatGroupMember },
  };
}
