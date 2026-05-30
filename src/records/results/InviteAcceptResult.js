import { SchemaRecord } from "../SchemaRecord.js";

export class InviteAcceptResult extends SchemaRecord {
  static type = "chat.result.invite_accept";
  static schema = {
    threadId: { type: "string", nullable: true, trim: true },
    peerLinkId: { type: "string", nullable: true, trim: true },
    peerAccountId: { type: "string", nullable: true, trim: true },
    state: { type: "string", required: true, trim: true },
    sessionState: { type: "string", nullable: true, trim: true },
    peerInboxId: { type: "string", nullable: true, trim: true },
    groupId: { type: "string", nullable: true, trim: true },
    groupThreadId: { type: "string", nullable: true, trim: true },
    remoteDisplayName: { type: "string", nullable: true, trim: true },
  };
}
