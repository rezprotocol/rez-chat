import { SchemaRecord } from "../SchemaRecord.js";

export class ThreadStateSetResult extends SchemaRecord {
  static type = "chat.result.thread_state_set";
  static schema = {
    thread: { type: "object", required: true },
  };
}
