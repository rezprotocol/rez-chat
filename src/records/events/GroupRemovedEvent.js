import { SchemaRecord } from "../SchemaRecord.js";

export class GroupRemovedEvent extends SchemaRecord {
  static type = "chat.evt.group_removed";
  static schema = {
    groupId: { type: "string", required: true, trim: true },
  };
}
