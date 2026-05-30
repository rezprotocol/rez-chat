import { SchemaRecord } from "../SchemaRecord.js";

export class GroupRenameParams extends SchemaRecord {
  static type = "chat.params.group_rename";
  static schema = {
    groupId: { type: "string", required: true, trim: true },
    title: { type: "string", required: true, trim: true },
  };
}
