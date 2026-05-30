import { SchemaRecord } from "../SchemaRecord.js";

export class GroupCreateParams extends SchemaRecord {
  static type = "chat.params.group_create";
  static schema = {
    title: { type: "string", trim: true },
  };
}
