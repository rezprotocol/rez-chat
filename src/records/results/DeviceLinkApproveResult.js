import { SchemaRecord } from "../SchemaRecord.js";

export class DeviceLinkApproveResult extends SchemaRecord {
  static type = "chat.result.device_link_approve";
  static schema = {
    state: { type: "string", required: true, trim: true },
    newDeviceId: { type: "string", required: true, trim: true },
  };
}
