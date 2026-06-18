import { SchemaRecord } from "../SchemaRecord.js";

export class GroupSetAvatarParams extends SchemaRecord {
  static type = "chat.params.group_set_avatar";
  static schema = {
    groupId: { type: "string", required: true, trim: true },
    // Base64 JPEG bytes of the new photo, or empty string to remove the photo.
    avatarDataB64: { type: "string", required: false, trim: false },
  };
}
