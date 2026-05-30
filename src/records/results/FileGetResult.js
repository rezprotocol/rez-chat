import { SchemaRecord } from "../SchemaRecord.js";

export class FileGetResult extends SchemaRecord {
  static type = "chat.result.file_get";
  static schema = {
    fileHashHex: { type: "string", trim: true },
    fileDataB64: { type: "string", trim: false },
    mimeType: { type: "string", trim: true },
    fileName: { type: "string", trim: true },
  };
}
