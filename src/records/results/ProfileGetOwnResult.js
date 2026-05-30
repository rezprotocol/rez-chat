import { SchemaRecord } from "../SchemaRecord.js";

export class ProfileGetOwnResult extends SchemaRecord {
  static type = "chat.result.profile_get_own";
  static schema = {
    displayName: { type: "string", trim: false },
    avatarFileHash: { type: "string", trim: false },
  };
}
