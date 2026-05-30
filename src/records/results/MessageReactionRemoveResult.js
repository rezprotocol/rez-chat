import { SchemaRecord } from "../SchemaRecord.js";

export class MessageReactionRemoveResult extends SchemaRecord {
  static type = "chat.result.message_reaction_remove";
  static schema = {
    threadId: { type: "string", required: true, trim: true },
    targetMessageId: { type: "string", required: true, trim: true },
    emoji: { type: "string", required: true, trim: true },
    createdAtMs: { type: "number", required: true },
  };
}
