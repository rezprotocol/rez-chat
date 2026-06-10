import { SchemaRecord } from "../SchemaRecord.js";

export class ContactsRequestConnectParams extends SchemaRecord {
  static type = "chat.params.contacts_request_connect";
  static schema = {
    peerAccountId: { type: "string", required: true, trim: true },
    displayName: { type: "string", nullable: true, trim: true },
    groupId: { type: "string", nullable: true, trim: true },
  };
}
