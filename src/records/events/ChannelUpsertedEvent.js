import { SchemaRecord } from "../SchemaRecord.js";
import { ChatChannel } from "../domain/ChatChannel.js";

export class ChannelUpsertedEvent extends SchemaRecord {
  static type = "chat.evt.channel_upserted";
  static schema = {
    channel: { type: "record", record: ChatChannel, required: true },
  };
}
