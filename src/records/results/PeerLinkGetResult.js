import { SchemaRecord } from "../SchemaRecord.js";

export class PeerLinkGetResult extends SchemaRecord {
  static type = "chat.result.peer_link_get";
  static schema = {
    peerLink: { type: "object", nullable: true },
  };
}
