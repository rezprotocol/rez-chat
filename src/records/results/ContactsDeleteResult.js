import { SchemaRecord } from "../SchemaRecord.js";

export class ContactsDeleteResult extends SchemaRecord {
  static type = "chat.result.contacts_delete";
  static schema = {
    deleted: { type: "boolean" },
  };
}
