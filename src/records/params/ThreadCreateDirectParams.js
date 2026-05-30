import { SchemaRecord } from "../SchemaRecord.js";

export class ThreadCreateDirectParams extends SchemaRecord {
  static type = "chat.params.thread_create_direct";
  static schema = {
    accountId: { type: "string", required: true, trim: true },
  };
}
