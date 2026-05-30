import { SchemaRecord } from "../SchemaRecord.js";

export class GroupMembersListParams extends SchemaRecord {
  static type = "chat.params.group_members_list";
  static schema = {
    groupId: { type: "string", required: true, trim: true },
  };
}
