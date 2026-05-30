import { SchemaRecord } from "../SchemaRecord.js";

export class ChannelRemovedEvent extends SchemaRecord {
  static type = "chat.evt.channel_removed";
  static schema = {
    groupId: { type: "string", required: true, trim: true },
    channelId: { type: "string", required: true, trim: true },
  };
}
