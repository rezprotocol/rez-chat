import { SchemaRecord } from "../SchemaRecord.js";

export class GroupKickResult extends SchemaRecord {
  static type = "chat.result.group_kick";
  static schema = {
    groupId: { type: "string", trim: true },
    accountId: { type: "string", trim: true },
    kicked: { type: "boolean" },
  };
}
