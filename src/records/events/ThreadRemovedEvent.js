import { SchemaRecord } from "../SchemaRecord.js";

export class ThreadRemovedEvent extends SchemaRecord {
  static type = "chat.evt.thread_removed";
  static schema = {
    threadId: { type: "string", required: true, trim: true },
  };
}
