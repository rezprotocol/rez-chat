import { SchemaRecord } from "../SchemaRecord.js";

export class ThreadsListParams extends SchemaRecord {
  static type = "chat.params.threads_list";
  static schema = {
    limit: { type: "int", default: 50, clamp: true, min: 1, max: 200 },
  };
}
