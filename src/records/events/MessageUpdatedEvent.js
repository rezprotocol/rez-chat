import { SchemaRecord } from "../SchemaRecord.js";
import { ChatMessage } from "../domain/ChatMessage.js";

export class MessageUpdatedEvent extends SchemaRecord {
  static type = "chat.evt.message_updated";
  static schema = {
    threadId: { type: "string", required: true, trim: true },
    message: { type: "record", record: ChatMessage, required: true },
  };
}
