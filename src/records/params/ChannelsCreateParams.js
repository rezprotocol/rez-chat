import { SchemaRecord } from "../SchemaRecord.js";

/**
 * channels.create params. Callers send EITHER:
 *   - `label`: free-form display text (server slugifies into channelId), OR
 *   - `channelId`: pre-slugified id (legacy; treated as both id and label).
 * At least one must be present and produce a valid slug.
 */
export class ChannelsCreateParams extends SchemaRecord {
  static type = "chat.params.channels_create";
  static schema = {
    groupId: { type: "string", required: true, trim: true },
    label: { type: "string", trim: false, maxLength: 128 },
    channelId: { type: "string", trim: true, maxLength: 64 },
  };
  validate() {
    super.validate();
    this.assert(this.label.length > 0 || this.channelId.length > 0,
      "ChannelsCreateParams: label or channelId required");
  }
}
