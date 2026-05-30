import { SchemaRecord } from "../SchemaRecord.js";

export class ThreadDeleteResult extends SchemaRecord {
  static type = "chat.result.thread_delete";
  static schema = {
    threadId: { type: "string", required: true, trim: true },
    deleted: { type: "boolean" },
  };
}
