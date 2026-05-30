import { SchemaRecord } from "../SchemaRecord.js";

export class PeerLinkGetParams extends SchemaRecord {
  static type = "chat.params.peer_link_get";
  static schema = {
    peerLinkId: { type: "string", required: true, trim: true },
  };
}
