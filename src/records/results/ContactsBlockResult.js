import { SchemaRecord } from "../SchemaRecord.js";

export class ContactsBlockResult extends SchemaRecord {
  static type = "chat.result.contacts_block";
  static schema = {
    contact: { type: "object", required: true },
  };
}
