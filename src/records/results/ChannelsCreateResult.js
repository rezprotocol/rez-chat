import { SchemaRecord } from "../SchemaRecord.js";
import { ChatChannel } from "../domain/ChatChannel.js";

export class ChannelsCreateResult extends SchemaRecord {
  static type = "chat.result.channels_create";
  static schema = {
    channel: { type: "record", record: ChatChannel, required: true },
    created: { type: "boolean" },
  };
}
