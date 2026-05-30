import { SchemaRecord } from "../SchemaRecord.js";

export class ThreadReadResult extends SchemaRecord {
  static type = "chat.result.thread_read";
  static schema = {
    threadId: { type: "string", required: true, trim: true },
    readAtMs: { type: "number", required: true },
  };
}
