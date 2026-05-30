import { SchemaRecord } from "../SchemaRecord.js";

export class MessageRemovedEvent extends SchemaRecord {
  static type = "chat.evt.message_removed";
  static schema = {
    threadId: { type: "string", required: true, trim: true },
    messageId: { type: "string", required: true, trim: true },
  };
}
