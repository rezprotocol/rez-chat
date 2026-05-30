import { SchemaRecord } from "../SchemaRecord.js";

export class InviteCreateResult extends SchemaRecord {
  static type = "chat.result.invite_create";
  static schema = {
    inviteCode: { type: "string", required: true, trim: true },
    peerLinkId: { type: "string", nullable: true, trim: true },
    inviteId: { type: "string", nullable: true, trim: true },
    state: { type: "string", nullable: true, trim: true },
    expiresAtMs: { type: "number", nullable: true },
    maxUses: { type: "int", default: 1, clamp: true, min: 1 },
  };
}
