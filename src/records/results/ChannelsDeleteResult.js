import { SchemaRecord } from "../SchemaRecord.js";

export class ChannelsDeleteResult extends SchemaRecord {
  static type = "chat.result.channels_delete";
  static schema = {
    groupId: { type: "string", required: true, trim: true },
    channelId: { type: "string", required: true, trim: true },
    deleted: { type: "boolean" },
  };
}
