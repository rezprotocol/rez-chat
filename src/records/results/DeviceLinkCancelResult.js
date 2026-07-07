import { SchemaRecord } from "../SchemaRecord.js";

export class DeviceLinkCancelResult extends SchemaRecord {
  static type = "chat.result.device_link_cancel";
  static schema = {
    state: { type: "string", required: true, trim: true },
  };
}
