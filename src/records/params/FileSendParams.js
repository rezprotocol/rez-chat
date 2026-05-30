import { SchemaRecord } from "../SchemaRecord.js";

export class FileSendParams extends SchemaRecord {
  static type = "chat.params.file_send";
  static schema = {
    threadId: { type: "string", required: true, trim: true },
    fileDataB64: { type: "string", required: true, trim: false, maxLength: 14_000_000 },
    fileName: { type: "string", required: true, trim: true },
    mimeType: { type: "string", required: true, trim: true },
    text: { type: "string", trim: true },
    channelId: { type: "string", trim: true, maxLength: 64 },
  };
}
