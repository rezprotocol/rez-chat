import { WirePayloadRecord } from "../WirePayloadRecord.js";

/**
 * ChatReactionPayloadV1: a reaction add/remove operation on a target
 * message, propagated as an encrypted-deposit payload. Out-of-order
 * arrivals are buffered against `targetMessageId` and replayed once the
 * target lands.
 */
export const REACTION_KIND = "rez.chat.reaction.v1";

export const REACTION_OPS = Object.freeze(["add", "remove"]);
const MAX_EMOJI_LENGTH = 16;

export class ChatReactionPayloadV1 extends WirePayloadRecord {
  static KIND = REACTION_KIND;
  static schema = {
    threadId: { type: "string", required: true, trim: true },
    targetMessageId: { type: "string", required: true, trim: true },
    emoji: { type: "string", required: true, trim: true, maxLength: MAX_EMOJI_LENGTH },
    op: { type: "enum", values: [...REACTION_OPS], required: true },
    senderAccountId: { type: "string", required: true, trim: true },
    createdAtMs: { type: "int", required: true },
  };
}
