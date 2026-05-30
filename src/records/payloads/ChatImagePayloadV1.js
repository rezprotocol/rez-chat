import { WirePayloadRecord } from "../WirePayloadRecord.js";
import { CHANNEL_ID_PATTERN } from "./ChatMessagePayloadV1.js";

/**
 * ChatImagePayloadV1: in-message image attachment body. Sent as a deposit
 * payload by ServerFileTransferService when an image is shared in a chat
 * thread. References a file hash transferred via the SDK file-transfer
 * service; the body itself carries presentation metadata + caption.
 *
 * `channelId` mirrors ChatMessagePayloadV1: optional logical-organization
 * tag (group-scoped). Empty == implicit "#general" bucket. Renderer filters
 * timeline by channelId; storage/fanout/threadId derivation are unaffected.
 */
export const IMAGE_KIND = "rez.image.v1";

const MAX_NAME_LENGTH = 255;
const MAX_MIME_LENGTH = 255;
const HEX_HASH_RE = /^[0-9a-f]{64}$/;

export class ChatImagePayloadV1 extends WirePayloadRecord {
  static KIND = IMAGE_KIND;
  static schema = {
    fileName: { type: "string", required: true, trim: true, maxLength: MAX_NAME_LENGTH },
    mimeType: { type: "string", default: "application/octet-stream", trim: true, maxLength: MAX_MIME_LENGTH },
    fileSizeBytes: { type: "int", required: true },
    fileHashHex: {
      type: "string",
      required: true,
      trim: true,
      lowercase: true,
      validate(value, record, name) {
        record.assert(HEX_HASH_RE.test(value), `${name} must be 64-char hex SHA-256`);
      },
    },
    text: { type: "string", trim: false },
    channelId: { type: "string", trim: true, maxLength: 64 },
  };

  validate() {
    super.validate();
    if (this.channelId.length > 0) {
      this.assert(CHANNEL_ID_PATTERN.test(this.channelId),
        `ChatImagePayloadV1.channelId must match ${CHANNEL_ID_PATTERN}, got '${this.channelId}'`);
    }
  }
}
