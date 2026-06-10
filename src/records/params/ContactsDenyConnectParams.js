import { SchemaRecord } from "../SchemaRecord.js";

export class ContactsDenyConnectParams extends SchemaRecord {
  static type = "chat.params.contacts_deny_connect";
  static schema = {
    accountId: { type: "string", required: true, trim: true },
  };
}
