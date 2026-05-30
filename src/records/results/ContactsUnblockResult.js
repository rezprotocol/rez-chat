import { SchemaRecord } from "../SchemaRecord.js";

export class ContactsUnblockResult extends SchemaRecord {
  static type = "chat.result.contacts_unblock";
  static schema = {
    contact: { type: "object", required: true },
  };
}
