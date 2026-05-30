import { SchemaRecord } from "../SchemaRecord.js";

export class NodeStatusResult extends SchemaRecord {
  static type = "chat.result.node_status";
  static schema = {
    status: { type: "object", required: true },
  };
}
