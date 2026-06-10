import { SchemaRecord } from "../SchemaRecord.js";

export class ContactsRequestConnectResult extends SchemaRecord {
  static type = "chat.result.contacts_request_connect";
  static schema = {
    // "sent" | "already-connected"
    status: { type: "string", trim: true },
    peerAccountId: { type: "string", trim: true },
    requestId: { type: "string", nullable: true, trim: true },
  };
}
