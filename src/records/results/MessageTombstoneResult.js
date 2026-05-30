import { SchemaRecord } from "../SchemaRecord.js";

export class MessageTombstoneResult extends SchemaRecord {
  static type = "chat.result.message_tombstone";
  static schema = {
    threadId: { type: "string", required: true, trim: true },
    targetMessageId: { type: "string", required: true, trim: true },
    tombstonedAtMs: { type: "number", required: true },
  };
}
