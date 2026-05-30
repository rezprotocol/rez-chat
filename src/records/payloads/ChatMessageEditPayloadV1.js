import { WirePayloadRecord } from "../WirePayloadRecord.js";

/**
 * ChatMessageEditPayloadV1: edit-in-place mutation on a target message,
 * propagated as an encrypted-deposit payload. Out-of-order arrivals use
 * `editedAtMs` for last-writer-wins. Authorization is enforced on the
 * recipient side: the deposit's authenticated sender must match the
 * original message's senderAccountId.
 */
export const MESSAGE_EDIT_KIND = "rez.chat.message.edit.v1";
const MAX_TEXT_LENGTH = 8192;

export class ChatMessageEditPayloadV1 extends WirePayloadRecord {
  static KIND = MESSAGE_EDIT_KIND;
  static schema = {
    threadId: { type: "string", required: true, trim: true },
    targetMessageId: { type: "string", required: true, trim: true },
    newText: { type: "string", trim: false, maxLength: MAX_TEXT_LENGTH },
    senderAccountId: { type: "string", required: true, trim: true },
    editedAtMs: { type: "int", required: true },
  };
}
