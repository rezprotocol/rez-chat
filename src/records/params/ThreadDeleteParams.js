import { SchemaRecord } from "../SchemaRecord.js";

export class ThreadDeleteParams extends SchemaRecord {
  static type = "chat.params.thread_delete";
  static schema = {
    threadId: { type: "string", required: true, trim: true },
  };
}
