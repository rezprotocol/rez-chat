import { SchemaRecord } from "../SchemaRecord.js";

export const PEER_LINK_STATES = Object.freeze([
  "initiating",
  "invite_created",
  "handshake_sent",
  "session_established",
  "established",
  "failed",
  "expired",
  "revoked",
]);

export class PeerLinkUpdatedEvent extends SchemaRecord {
  static type = "chat.evt.peer_link_updated";
  static schema = {
    peerLinkId: { type: "string", required: true, trim: true },
    threadId: { type: "string", nullable: true, trim: false },
    state: { type: "enum", values: [...PEER_LINK_STATES], required: true },
    peerAccountId: { type: "string", nullable: true, trim: false },
    sessionState: { type: "string", nullable: true, trim: false },
    lastErrorMessage: { type: "string", nullable: true, trim: false },
  };
}
