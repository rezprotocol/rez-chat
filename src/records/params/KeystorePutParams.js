import { SchemaRecord } from "../SchemaRecord.js";

export class KeystorePutParams extends SchemaRecord {
  static type = "chat.params.keystore_put";
  static schema = {
    accountId: { type: "string", required: true, trim: true },
    envelope: { type: "object", required: true },
  };
}
