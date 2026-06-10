import { SchemaRecord } from "../SchemaRecord.js";

export class ContactsApproveConnectParams extends SchemaRecord {
  static type = "chat.params.contacts_approve_connect";
  static schema = {
    accountId: { type: "string", required: true, trim: true },
    acceptorDisplayName: { type: "string", nullable: true, trim: true },
  };
}
