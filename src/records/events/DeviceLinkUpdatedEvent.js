import { SchemaRecord } from "../SchemaRecord.js";

// Device-link ceremony progress on the PRIMARY device (S2.5 S10). States:
// code-issued | pending | responding | confirmed | cancelled | expired | failed.
// `pending` carries the requesting device's id + fingerprint — the UI shows
// them for the human cross-check before deviceLink.approve.
export class DeviceLinkUpdatedEvent extends SchemaRecord {
  static type = "chat.evt.device_link_updated";
  static schema = {
    state: { type: "string", required: true, trim: true },
    newDeviceId: { type: "string", nullable: true, trim: true },
    fingerprint: { type: "string", nullable: true, trim: true },
    expiresAtMs: { type: "int", nullable: true },
    message: { type: "string", nullable: true },
  };
}
