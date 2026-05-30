import { SchemaRecord } from "../SchemaRecord.js";

export class ContactsUnblockParams extends SchemaRecord {
  static type = "chat.params.contacts_unblock";
  static schema = {
    accountId: { type: "string", required: true, trim: true },
  };
}
