import { SchemaRecord } from "../SchemaRecord.js";

export class GroupCreateResult extends SchemaRecord {
  static type = "chat.result.group_create";
  static schema = {
    groupId: { type: "string", required: true, trim: true },
    threadId: { type: "string", trim: true },
  };
}
