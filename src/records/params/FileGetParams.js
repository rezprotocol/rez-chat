import { SchemaRecord } from "../SchemaRecord.js";

const HEX_64_RE = /^[0-9a-f]{64}$/;

export class FileGetParams extends SchemaRecord {
  static type = "chat.params.file_get";
  static schema = {
    fileHashHex: {
      type: "string",
      trim: true,
      validate(value, record, name) {
        record.assert(HEX_64_RE.test(value), `${name} must be 64-char hex`);
      },
    },
  };
}
