import { SchemaRecord } from "../SchemaRecord.js";

export class ContactsRenameParams extends SchemaRecord {
  static type = "chat.params.contacts_rename";
  static schema = {
    accountId: { type: "string", required: true, trim: true },
    displayName: { type: "string", nullable: true, trim: true },
  };
}
