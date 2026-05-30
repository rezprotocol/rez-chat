import { SchemaRecord } from "../SchemaRecord.js";

export class InviteAcceptParams extends SchemaRecord {
  static type = "chat.params.invite_accept";
  static schema = {
    inviteCode: { type: "string", required: true, trim: true },
    acceptorDisplayName: { type: "string", nullable: true, trim: true },
  };
}
