import { SchemaRecord } from "../SchemaRecord.js";

export class ChannelsListParams extends SchemaRecord {
  static type = "chat.params.channels_list";
  static schema = {
    groupId: { type: "string", required: true, trim: true },
    includeDeleted: { type: "boolean" },
  };
}
