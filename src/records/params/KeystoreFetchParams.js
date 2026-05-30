import { SchemaRecord } from "../SchemaRecord.js";

export class KeystoreFetchParams extends SchemaRecord {
  static type = "chat.params.keystore_fetch";
  static schema = {
    accountId: { type: "string", required: true, trim: true },
  };
}
