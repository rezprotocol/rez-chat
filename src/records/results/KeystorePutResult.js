import { SchemaRecord } from "../SchemaRecord.js";

export class KeystorePutResult extends SchemaRecord {
  static type = "chat.result.keystore_put";
  static schema = {
    ok: { type: "boolean" },
  };
}
