import { SchemaRecord } from "../SchemaRecord.js";

export class FileSendResult extends SchemaRecord {
  static type = "chat.result.file_send";
  static schema = {
    threadId: { type: "string", trim: true },
    messageId: { type: "string", trim: true },
    fileHashHex: { type: "string", trim: true },
    transferId: { type: "string", trim: true },
  };
}
