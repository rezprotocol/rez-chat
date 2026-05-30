import { WirePayloadRecord } from "../WirePayloadRecord.js";

/**
 * ChatMessagePayloadV1: the primary outbound chat message body. Embedded
 * (encrypted) as the deposit payload on the wire. Self-contained: carries
 * threadId / senderAccountId / messageId in the body itself.
 *
 * `channelId` is an optional logical-organization tag (group-scoped). Empty
 * string == the implicit "#general" bucket. Non-empty must match
 * CHANNEL_ID_PATTERN. The recipient's chat layer filters timeline rendering
 * by channelId; storage/fanout/threadId derivation are unaffected.
 */
export const MESSAGE_KIND = "rez.chat.message.v1";
const MAX_TEXT_LENGTH = 8192;
export const CHANNEL_ID_PATTERN = /^[a-z0-9_-]{1,64}$/;
export const GENERAL_CHANNEL_ID = "";

export function isValidChannelId(channelId) {
  if (typeof channelId !== "string" || channelId.length === 0) return false;
  return CHANNEL_ID_PATTERN.test(channelId);
}

/**
 * Derive a wire-safe channelId slug from a user-typed label. Lowercases,
 * strips combining diacritics, replaces any run of disallowed characters
 * with `-`, collapses repeats, trims leading/trailing separators, and
 * truncates to 64 chars. Returns "" when the label has no valid characters.
 * Callers must check for "" and reject — empty slug is not a valid channelId.
 */
export function slugifyChannelLabel(label) {
  const str = String(label == null ? "" : label).toLowerCase().normalize("NFKD");
  const stripped = str.replace(/[̀-ͯ]/g, "");
  const slugified = stripped.replace(/[^a-z0-9_-]+/g, "-");
  const trimmed = slugified.replace(/-+/g, "-").replace(/^[-_]+|[-_]+$/g, "");
  return trimmed.slice(0, 64);
}

export class ChatMessagePayloadV1 extends WirePayloadRecord {
  static KIND = MESSAGE_KIND;
  static schema = {
    threadId: { type: "string", required: true, trim: true },
    senderAccountId: { type: "string", required: true, trim: true },
    messageId: { type: "string", required: true, trim: true },
    text: { type: "string", trim: false, maxLength: MAX_TEXT_LENGTH },
    inReplyToMessageId: { type: "string", trim: true },
    channelId: { type: "string", trim: true, maxLength: 64 },
  };

  validate() {
    super.validate();
    if (this.channelId.length > 0) {
      this.assert(CHANNEL_ID_PATTERN.test(this.channelId),
        `ChatMessagePayloadV1.channelId must match ${CHANNEL_ID_PATTERN}, got '${this.channelId}'`);
    }
  }
}
