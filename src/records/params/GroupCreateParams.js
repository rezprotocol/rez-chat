import { SchemaRecord } from "../SchemaRecord.js";

export class GroupCreateParams extends SchemaRecord {
  static type = "chat.params.group_create";
  static schema = {
    title: { type: "string", trim: true },
    // The creator's display name, set on their membership row at creation so the
    // founder is named in their OWN roster immediately — not left blank until the
    // first invite's self-proof fills it (implicit coupling that left the creator
    // showing a bare account id). The node has no access to the vault profile
    // name, so the client supplies it explicitly.
    creatorDisplayName: { type: "string", nullable: true, trim: true },
  };
}
