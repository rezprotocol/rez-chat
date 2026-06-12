import { SchemaRecord } from "../SchemaRecord.js";

export class InviteAcceptParams extends SchemaRecord {
  static type = "chat.params.invite_accept";
  static schema = {
    inviteCode: { type: "string", required: true, trim: true },
    acceptorDisplayName: { type: "string", nullable: true, trim: true },
    // Opt an already-established link into a fresh X3DH re-key (link recovery /
    // auto-reconnect). Without it, accepting on a healthy link is idempotent and
    // sends the inviter nothing. Reuses the same peerLinkId — history is kept.
    forceReestablish: { type: "boolean" },
  };
}
