import { SchemaRecord } from "../SchemaRecord.js";

export class ProfileBroadcastParams extends SchemaRecord {
  static type = "chat.params.profile_broadcast";
  static schema = {
    displayName: { type: "string", required: true, trim: true, maxLength: 64 },
    avatarDataB64: { type: "string", trim: false },
  };
}
