import { SchemaRecord } from "../SchemaRecord.js";

export class ChannelsSyncAllResult extends SchemaRecord {
  static type = "chat.result.channels_syncall";
  static schema = {
    requestsSent: { type: "int", required: false },
  };
}
