import { SchemaRecord } from "../SchemaRecord.js";

export class KeystoreFetchResult extends SchemaRecord {
  static type = "chat.result.keystore_fetch";
  static schema = {
    envelope: { type: "object", nullable: true },
  };
}
