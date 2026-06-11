import { SchemaRecord } from "../SchemaRecord.js";

export class ContactsDenyConnectResult extends SchemaRecord {
  static type = "chat.result.contacts_deny_connect";
  static schema = {
    status: { type: "string", trim: true },
    peerAccountId: { type: "string", trim: true },
    deleted: { type: "boolean" },
  };
}
