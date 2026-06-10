import { SchemaRecord } from "../SchemaRecord.js";
import { ChatThread } from "../domain/ChatThread.js";

export class ThreadUpdatedEvent extends SchemaRecord {
  static type = "chat.evt.thread_updated";
  static schema = {
    thread: { type: "record", record: ChatThread, required: true },
  };
}
