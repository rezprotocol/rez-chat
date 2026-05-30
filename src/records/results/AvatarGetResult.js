import { SchemaRecord } from "../SchemaRecord.js";

export class AvatarGetResult extends SchemaRecord {
  static type = "chat.result.avatar_get";
  static schema = {
    avatarDataB64: { type: "string", trim: false },
  };
}
