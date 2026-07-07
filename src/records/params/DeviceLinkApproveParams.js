import { SchemaRecord } from "../SchemaRecord.js";

export class DeviceLinkApproveParams extends SchemaRecord {
  static type = "chat.params.device_link_approve";
  static schema = {
    // Must echo the PENDING request's device id — a stale approve aimed at a
    // different request is rejected (TOCTOU guard).
    newDeviceId: { type: "string", required: true, trim: true },
  };
}
