import { SchemaRecord } from "../SchemaRecord.js";

export class ContactsDeleteParams extends SchemaRecord {
  static type = "chat.params.contacts_delete";
  static schema = {
    accountId: { type: "string", required: true, trim: true },
  };
}
