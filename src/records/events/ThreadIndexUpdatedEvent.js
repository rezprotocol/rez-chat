import { SchemaRecord } from "../SchemaRecord.js";

export class ThreadIndexUpdatedEvent extends SchemaRecord {
  static type = "chat.evt.thread_index_updated";
  static schema = {
    threadId: { type: "string", required: true, trim: true },
    lastActivityAtMs: { type: "number" },
    preview: { type: "string", nullable: true, trim: false },
    unreadCount: { type: "int", default: 0, clamp: true, min: 0 },
    // Per-channel unread breakdown. Keys are channelIds; the "#general"
    // bucket is keyed `""`. Channels with 0 unread are omitted; the sum
    // of values equals `unreadCount`.
    unreadByChannelId: { type: "object", default: {} },
  };
}
