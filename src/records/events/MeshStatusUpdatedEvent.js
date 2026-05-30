import { SchemaRecord } from "../SchemaRecord.js";
import { MeshStatus } from "../domain/MeshStatus.js";

export class MeshStatusUpdatedEvent extends SchemaRecord {
  static type = "chat.evt.mesh_status_updated";
  static schema = {
    mesh: { type: "record", record: MeshStatus, required: true },
  };
}
