import { SchemaRecord } from "../SchemaRecord.js";

export class ContactsBlockParams extends SchemaRecord {
  static type = "chat.params.contacts_block";
  static schema = {
    accountId: { type: "string", required: true, trim: true },
  };
}
