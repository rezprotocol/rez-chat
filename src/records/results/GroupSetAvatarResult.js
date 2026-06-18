import { SchemaRecord } from "../SchemaRecord.js";

export class GroupSetAvatarResult extends SchemaRecord {
  static type = "chat.result.group_set_avatar";
  static schema = {
    group: { type: "object", required: true },
  };
}
