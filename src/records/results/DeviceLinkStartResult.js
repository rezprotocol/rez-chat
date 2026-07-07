import { SchemaRecord } from "../SchemaRecord.js";

export class DeviceLinkStartResult extends SchemaRecord {
  static type = "chat.result.device_link_start";
  static schema = {
    linkCode: { type: "string", required: true, trim: true },
    expiresAtMs: { type: "int", required: true },
  };
}
