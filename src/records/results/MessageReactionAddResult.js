import { SchemaRecord } from "../SchemaRecord.js";

export class MessageReactionAddResult extends SchemaRecord {
  static type = "chat.result.message_reaction_add";
  static schema = {
    threadId: { type: "string", required: true, trim: true },
    targetMessageId: { type: "string", required: true, trim: true },
    emoji: { type: "string", required: true, trim: true },
    createdAtMs: { type: "number", required: true },
  };
}
