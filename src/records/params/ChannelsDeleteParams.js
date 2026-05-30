import { SchemaRecord } from "../SchemaRecord.js";

export class ChannelsDeleteParams extends SchemaRecord {
  static type = "chat.params.channels_delete";
  static schema = {
    groupId: { type: "string", required: true, trim: true },
    channelId: { type: "string", required: true, trim: true, maxLength: 64 },
  };
}
