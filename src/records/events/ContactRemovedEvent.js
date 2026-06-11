import { SchemaRecord } from "../SchemaRecord.js";

export class ContactRemovedEvent extends SchemaRecord {
  static type = "chat.evt.contact_removed";
  static schema = {
    accountId: { type: "string", required: true, trim: true },
  };
}
