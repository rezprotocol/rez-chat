import { SchemaRecord } from "../SchemaRecord.js";

export class GroupSetRoleResult extends SchemaRecord {
  static type = "chat.result.group_set_role";
  static schema = {
    groupId: { type: "string", trim: true },
    accountId: { type: "string", trim: true },
    role: { type: "string", trim: true },
  };
}
