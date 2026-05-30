import { SchemaRecord } from "../SchemaRecord.js";

export class MessageTombstoneParams extends SchemaRecord {
  static type = "chat.params.message_tombstone";
  static schema = {
    threadId: { type: "string", required: true, trim: true },
    targetMessageId: { type: "string", required: true, trim: true },
  };
}
