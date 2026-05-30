import { SchemaRecord } from "../SchemaRecord.js";

export class ThreadStateSetParams extends SchemaRecord {
  static type = "chat.params.thread_state_set";
  static schema = {
    threadId: { type: "string", required: true, trim: true },
    visibilityState: { type: "string", nullable: true, trim: true },
    accessState: { type: "string", nullable: true, trim: true },
  };
}
