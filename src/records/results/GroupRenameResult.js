import { SchemaRecord } from "../SchemaRecord.js";

export class GroupRenameResult extends SchemaRecord {
  static type = "chat.result.group_rename";
  static schema = {
    group: { type: "object", required: true },
  };
}
