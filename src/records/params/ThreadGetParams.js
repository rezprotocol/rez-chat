import { SchemaRecord } from "../SchemaRecord.js";

export class ThreadGetParams extends SchemaRecord {
  static type = "chat.params.thread_get";
  static schema = {
    threadId: { type: "string", required: true, trim: true },
    limit: { type: "int", default: 50, clamp: true, min: 1, max: 200 },
  };
}
