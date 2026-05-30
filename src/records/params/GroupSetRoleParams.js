import { SchemaRecord } from "../SchemaRecord.js";

export class GroupSetRoleParams extends SchemaRecord {
  static type = "chat.params.group_set_role";
  static schema = {
    groupId: { type: "string", required: true, trim: true },
    accountId: { type: "string", required: true, trim: true },
    role: { type: "enum", values: ["admin", "member"], required: true },
  };
}
