import { SchemaRecord } from "../SchemaRecord.js";
import { ChatContact } from "../domain/ChatContact.js";

export class ContactsListResult extends SchemaRecord {
  static type = "chat.result.contacts_list";
  static schema = {
    items: { type: "array", record: ChatContact },
  };
}
