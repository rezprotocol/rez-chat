import { SchemaRecord } from "../SchemaRecord.js";

export class ThreadMessagesListParams extends SchemaRecord {
  static type = "chat.params.thread_messages_list";
  static schema = {
    threadId: { type: "string", required: true, trim: true },
    limit: { type: "int", default: 50, clamp: true, min: 1, max: 200 },
    before: { type: "object", nullable: true },
  };
}
