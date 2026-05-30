import { SchemaRecord } from "../SchemaRecord.js";

export class ThreadChannelReadParams extends SchemaRecord {
  static type = "chat.params.thread_channel_read";
  static schema = {
    threadId: { type: "string", required: true, trim: true },
    // Empty string targets the implicit "#general" bucket.
    channelId: { type: "string", default: "", trim: true },
  };
}
