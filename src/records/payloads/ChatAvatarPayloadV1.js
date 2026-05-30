import { WirePayloadRecord } from "../WirePayloadRecord.js";

/**
 * ChatAvatarPayloadV1: peer-to-peer avatar image transfer, sent inline
 * with a profile update when the avatar hash changes. Bytes ride in
 * fileDataB64 (Base64) because avatars are small and a separate
 * file-transfer handshake would be wasteful.
 */
export const AVATAR_KIND = "rez.avatar.v1";

const HEX_HASH_RE = /^[0-9a-f]{64}$/;
const MAX_B64_LENGTH = 4 * 1024 * 1024; // 4 MB base64 ~ 3 MB binary

export class ChatAvatarPayloadV1 extends WirePayloadRecord {
  static KIND = AVATAR_KIND;
  static schema = {
    fileHashHex: {
      type: "string",
      required: true,
      trim: true,
      lowercase: true,
      validate(value, record, name) {
        record.assert(HEX_HASH_RE.test(value), `${name} must be 64-char hex SHA-256`);
      },
    },
    fileDataB64: { type: "string", required: true, trim: false, maxLength: MAX_B64_LENGTH },
  };
}
