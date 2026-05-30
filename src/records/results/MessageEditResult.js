import { SchemaRecord } from "../SchemaRecord.js";

export class MessageEditResult extends SchemaRecord {
  static type = "chat.result.message_edit";
  static schema = {
    threadId: { type: "string", required: true, trim: true },
    targetMessageId: { type: "string", required: true, trim: true },
    editedAtMs: { type: "number", required: true },
  };
}
