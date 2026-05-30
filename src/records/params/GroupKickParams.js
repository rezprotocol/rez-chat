import { SchemaRecord } from "../SchemaRecord.js";

export class GroupKickParams extends SchemaRecord {
  static type = "chat.params.group_kick";
  static schema = {
    groupId: { type: "string", required: true, trim: true },
    accountId: { type: "string", required: true, trim: true },
  };
}
