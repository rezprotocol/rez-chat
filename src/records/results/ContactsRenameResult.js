import { SchemaRecord } from "../SchemaRecord.js";

export class ContactsRenameResult extends SchemaRecord {
  static type = "chat.result.contacts_rename";
  static schema = {
    contact: { type: "object", required: true },
  };
}
