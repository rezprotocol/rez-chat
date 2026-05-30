import { SchemaRecord } from "../SchemaRecord.js";
import { ChatChannel } from "../domain/ChatChannel.js";

export class ChannelsListResult extends SchemaRecord {
  static type = "chat.result.channels_list";
  static schema = {
    groupId: { type: "string", required: true, trim: true },
    items: { type: "array", record: ChatChannel },
  };
}
