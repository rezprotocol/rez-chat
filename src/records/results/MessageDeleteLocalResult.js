import { SchemaRecord } from "../SchemaRecord.js";

export class MessageDeleteLocalResult extends SchemaRecord {
  static type = "chat.result.message_delete_local";
  static schema = {
    threadId: { type: "string", required: true, trim: true },
    targetMessageId: { type: "string", required: true, trim: true },
    removed: { type: "boolean" },
  };
}
