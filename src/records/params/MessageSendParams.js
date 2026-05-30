import { SchemaRecord } from "../SchemaRecord.js";

export class MessageSendParams extends SchemaRecord {
  static type = "chat.params.message_send";
  static schema = {
    threadId: { type: "string", required: true, trim: true },
    payload: { type: "object", required: true, maxJsonBytes: 262144 },
    targetCapabilityId: { type: "string", trim: true },
    messageId: { type: "string", nullable: true, trim: true },
    inReplyToMessageId: { type: "string", trim: true },
    channelId: { type: "string", trim: true, maxLength: 64 },
  };
}
