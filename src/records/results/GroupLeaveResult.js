import { SchemaRecord } from "../SchemaRecord.js";

export class GroupLeaveResult extends SchemaRecord {
  static type = "chat.result.group_leave";
  static schema = {
    groupId: { type: "string", trim: true },
    threadId: { type: "string", trim: true },
    left: { type: "boolean" },
  };
}
