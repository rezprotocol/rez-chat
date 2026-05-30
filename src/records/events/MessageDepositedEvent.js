import { SchemaRecord } from "../SchemaRecord.js";
import { ChatMessage } from "../domain/ChatMessage.js";

export class MessageDepositedEvent extends SchemaRecord {
  static type = "chat.evt.message_deposited";
  static schema = {
    threadId: { type: "string", required: true, trim: true },
    message: { type: "record", record: ChatMessage, required: true },
  };
}
