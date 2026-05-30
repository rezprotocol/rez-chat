import { SchemaRecord } from "../SchemaRecord.js";

export class ThreadReadParams extends SchemaRecord {
  static type = "chat.params.thread_read";
  static schema = {
    threadId: { type: "string", required: true, trim: true },
  };
}
