import { SchemaRecord } from "../SchemaRecord.js";
import { ChatContact } from "../domain/ChatContact.js";

export class ContactUpdatedEvent extends SchemaRecord {
  static type = "chat.evt.contact_updated";
  static schema = {
    contact: { type: "record", record: ChatContact, required: true },
  };
}
