import { WirePayloadRecord } from "../WirePayloadRecord.js";

/**
 * ChatMessageTombstonePayloadV1: application-level request to hide / clear
 * the body of an earlier message on the recipient's local store. The
 * relay copy is unaffected (append-only). Authorization: the deposit's
 * authenticated sender must equal the target message's senderAccountId.
 */
export const MESSAGE_TOMBSTONE_KIND = "rez.chat.message.tombstone.v1";

export class ChatMessageTombstonePayloadV1 extends WirePayloadRecord {
  static KIND = MESSAGE_TOMBSTONE_KIND;
  static schema = {
    threadId: { type: "string", required: true, trim: true },
    targetMessageId: { type: "string", required: true, trim: true },
    senderAccountId: { type: "string", required: true, trim: true },
    tombstonedAtMs: { type: "int", required: true },
  };
}
