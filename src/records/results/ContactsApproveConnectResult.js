import { SchemaRecord } from "../SchemaRecord.js";

export class ContactsApproveConnectResult extends SchemaRecord {
  static type = "chat.result.contacts_approve_connect";
  static schema = {
    status: { type: "string", trim: true },
    peerAccountId: { type: "string", trim: true },
  };
}
