import { SchemaRecord } from "../SchemaRecord.js";

export class DeviceLinkStartParams extends SchemaRecord {
  static type = "chat.params.device_link_start";
  // No caller inputs: the PSK, its TTL, and the granted capabilities are
  // protocol-owned (confused-deputy guard).
  static schema = {};
}
