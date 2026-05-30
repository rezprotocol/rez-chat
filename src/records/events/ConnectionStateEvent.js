import { SchemaRecord } from "../SchemaRecord.js";

const ALLOWED_STATUSES = [
  "connected",
  "disconnected",
  "not_ready",
  "connecting",
  "reconnecting",
  "offline",
];

export class ConnectionStateEvent extends SchemaRecord {
  static type = "chat.evt.connection_state";
  static schema = {
    status: { type: "enum", values: ALLOWED_STATUSES, required: true },
    activeUplink: { type: "string", trim: true },
    reason: { type: "string", trim: true },
  };
}
