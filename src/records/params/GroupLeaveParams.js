import { SchemaRecord } from "../SchemaRecord.js";

export class GroupLeaveParams extends SchemaRecord {
  static type = "chat.params.group_leave";
  static schema = {
    groupId: { type: "string", required: true, trim: true },
  };
}
