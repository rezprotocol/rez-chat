import { SchemaRecord } from "../SchemaRecord.js";

export class DeviceLinkStatusResult extends SchemaRecord {
  static type = "chat.result.device_link_status";
  static schema = {
    state: { type: "string", required: true, trim: true },
    newDeviceId: { type: "string", nullable: true, trim: true },
    fingerprint: { type: "string", nullable: true, trim: true },
    expiresAtMs: { type: "int", nullable: true },
    message: { type: "string", nullable: true },
  };
}
