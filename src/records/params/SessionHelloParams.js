import { SchemaRecord } from "../SchemaRecord.js";

export class SessionHelloParams extends SchemaRecord {
  static type = "chat.params.session_hello";
  static schema = {
    accountId: { type: "string", required: true, trim: true },
    deviceId: { type: "string", required: true, trim: true },
    bridgeToken: { type: "string", trim: false },
  };
}
