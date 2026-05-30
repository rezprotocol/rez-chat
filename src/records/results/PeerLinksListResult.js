import { SchemaRecord } from "../SchemaRecord.js";

export class PeerLinksListResult extends SchemaRecord {
  static type = "chat.result.peer_links_list";
  static schema = {
    items: { type: "array" },
  };
}
