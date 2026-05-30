import { SchemaRecord } from "../SchemaRecord.js";

export class MessageSendResult extends SchemaRecord {
  static type = "chat.result.message_send";
  static schema = {
    threadId: { type: "string", required: true, trim: true },
    messageId: { type: "string", required: true, trim: true },
    acceptedAtMs: { type: "number", required: true },
    packetB64: { type: "string", trim: true },
  };
}
