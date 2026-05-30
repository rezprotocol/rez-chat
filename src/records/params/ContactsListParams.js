import { SchemaRecord } from "../SchemaRecord.js";

export class ContactsListParams extends SchemaRecord {
  static type = "chat.params.contacts_list";
  static schema = {
    state: { type: "string", nullable: true, trim: true },
  };
}
