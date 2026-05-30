import { SchemaRecord } from "../SchemaRecord.js";

export class MeshStatusResult extends SchemaRecord {
  static type = "chat.result.mesh_status";
  static schema = {
    mesh: { type: "object", required: true },
  };
}
