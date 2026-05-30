import { SchemaRecord } from "../SchemaRecord.js";
import { MESSAGE_STATUSES } from "../domain/ChatMessage.js";

export class MessageStatusEvent extends SchemaRecord {
  static type = "chat.evt.message_status";
  static schema = {
    threadId: { type: "string", required: true, trim: true },
    messageId: { type: "string", required: true, trim: true },
    status: { type: "enum", values: [...MESSAGE_STATUSES], required: true },
    sentAtMs: { type: "number", nullable: true },
  };
}
