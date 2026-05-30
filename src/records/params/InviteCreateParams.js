import { SchemaRecord } from "../SchemaRecord.js";

export class InviteCreateParams extends SchemaRecord {
  static type = "chat.params.invite_create";
  static schema = {
    kind: { type: "string", default: "direct", trim: true },
    groupId: { type: "string", nullable: true, trim: true },
    maxUses: { type: "int", default: 1, clamp: true, min: 1 },
    creatorDisplayName: { type: "string", nullable: true, trim: true },
    // For group invites: optional title carried in the invite envelope so the
    // acceptor can name the group locally before any group-op fanout arrives.
    title: { type: "string", nullable: true, trim: true, maxLength: 128 },
  };
}
