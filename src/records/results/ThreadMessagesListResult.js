import { SchemaRecord } from "../SchemaRecord.js";
import { ChatMessage } from "../domain/ChatMessage.js";

export class ThreadMessagesListResult extends SchemaRecord {
  static type = "chat.result.thread_messages_list";
  static schema = {
    items: { type: "array", record: ChatMessage },
    nextBefore: { type: "object", nullable: true },
  };
}
