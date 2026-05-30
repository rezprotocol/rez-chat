import { SchemaRecord } from "../SchemaRecord.js";

const MAX_EMOJI_LENGTH = 16;

export class MessageReactionRemoveParams extends SchemaRecord {
  static type = "chat.params.message_reaction_remove";
  static schema = {
    threadId: { type: "string", required: true, trim: true },
    targetMessageId: { type: "string", required: true, trim: true },
    emoji: { type: "string", required: true, trim: true, maxLength: MAX_EMOJI_LENGTH },
  };
}
