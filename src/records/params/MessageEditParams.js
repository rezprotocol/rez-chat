import { SchemaRecord } from "../SchemaRecord.js";

const MAX_TEXT_LENGTH = 8192;

export class MessageEditParams extends SchemaRecord {
  static type = "chat.params.message_edit";
  static schema = {
    threadId: { type: "string", required: true, trim: true },
    targetMessageId: { type: "string", required: true, trim: true },
    newText: { type: "string", trim: false, maxLength: MAX_TEXT_LENGTH },
  };
}
