import { SchemaRecord } from "../SchemaRecord.js";

export class ProfileBroadcastResult extends SchemaRecord {
  static type = "chat.result.profile_broadcast";
  static schema = {
    sent: { type: "number" },
    failed: { type: "number" },
    avatarFileHash: { type: "string", trim: false },
  };
}
