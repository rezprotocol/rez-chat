import { SchemaRecord } from "../SchemaRecord.js";

export class SessionHelloResult extends SchemaRecord {
  static type = "chat.result.session_hello";
  static schema = {
    accountId: { type: "string", required: true, trim: true },
    deviceId: { type: "string", required: true, trim: true },
    ownerAccountId: { type: "string", required: true, trim: true },
    localInboxId: { type: "string", required: true, trim: true },
  };
}
