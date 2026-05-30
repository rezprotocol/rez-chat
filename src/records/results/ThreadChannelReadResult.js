import { SchemaRecord } from "../SchemaRecord.js";

export class ThreadChannelReadResult extends SchemaRecord {
  static type = "chat.result.thread_channel_read";
  static schema = {
    threadId: { type: "string", required: true, trim: true },
    channelId: { type: "string", default: "", trim: true },
    readAtMs: { type: "number", required: true },
  };
}
