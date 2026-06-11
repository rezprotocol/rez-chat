import { SchemaRecord } from "../SchemaRecord.js";

export class ConnectRequestUpdatedEvent extends SchemaRecord {
  static type = "chat.evt.connect_request_updated";
  static schema = {
    peerAccountId: { type: "string", required: true, trim: true },
  };
}
