import { SchemaRecord } from "../SchemaRecord.js";
import { ChatThread } from "../domain/ChatThread.js";

export class ThreadsListResult extends SchemaRecord {
  static type = "chat.result.threads_list";
  static schema = {
    threads: { type: "array", record: ChatThread },
    cursor: { type: "string", nullable: true, trim: true },
  };
}
