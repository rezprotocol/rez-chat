import { SchemaRecord } from "../SchemaRecord.js";

export class MessageDeleteLocalParams extends SchemaRecord {
  static type = "chat.params.message_delete_local";
  static schema = {
    threadId: { type: "string", required: true, trim: true },
    targetMessageId: { type: "string", required: true, trim: true },
  };
}
