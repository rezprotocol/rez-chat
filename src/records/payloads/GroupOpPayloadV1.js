import { WirePayloadRecord } from "../WirePayloadRecord.js";
import { CHANNEL_ID_PATTERN } from "./ChatMessagePayloadV1.js";

/**
 * GroupOpPayloadV1: a group state mutation propagated from the actor to
 * other members. Op-specific required fields:
 *   - rename         { groupId, title, actedAtMs, groupOpId }
 *   - kick           { groupId, accountId, actedAtMs, groupOpId }
 *   - setRole        { groupId, accountId, role, actedAtMs, groupOpId }
 *   - leave          { groupId, accountId, actedAtMs, groupOpId }
 *   - channel.create { groupId, channelId, label?, actedAtMs, groupOpId }
 *   - channel.delete { groupId, channelId, actedAtMs, groupOpId }
 *   - channels.sync_request { groupId, actedAtMs, groupOpId }
 *   - group.state    { groupId, title, actedAtMs, groupOpId }
 *   - member.join    { groupId, accountId, inviteId, displayName?, actedAtMs, groupOpId }
 *
 * Authorization is enforced on the recipient side: the sender must be a
 * current member of the group; for admin-only ops the sender must be an
 * admin in the recipient's local view. Out-of-order ops use `actedAtMs`
 * for last-writer-wins.
 *
 * `group.state` is an explicit catch-up advertisement (NOT a rename): the
 * responder of a sync request tells the requester "here is my current view
 * of the group's title". Receiver semantics are fill-if-empty — never
 * overwrites a non-empty local title. Distinct from `rename` because it's
 * not a user-initiated mutation; LWW does not apply.
 *
 * member.join is the bootstrap exception — the sender (joining peer) is
 * NOT yet a group member when announcing themselves. Authorization is
 * proved against the inviter's persisted invite record by `inviteId`. The
 * inviter, after applying locally, forwards the same op to every other
 * active member (shape B); those forward recipients trust the inviter's
 * forward (sender-must-be-member gate applies as normal).
 *
 * The implicit "#general" channel (channelId === "") is undeletable. The
 * channel.delete op handler refuses the empty channelId; the validator
 * here also requires a non-empty channelId for both channel ops.
 *
 * `channels.sync_request` is a pull from the sender: when a member
 * observes a message tagged with a channelId they don't know, they ask
 * the sender to replay every channel.create for the group. The recipient
 * of the sync request answers via existing channel.create fan-out.
 */
export const GROUP_OP_KIND = "rez.group-op.v1";

export const GROUP_OPS = Object.freeze([
  "rename", "kick", "setRole", "leave", "channel.create", "channel.delete",
  "channels.sync_request", "group.state", "member.join",
]);
export const GROUP_OP_ROLES = Object.freeze(["admin", "member"]);
const VALID_ROLES = new Set(GROUP_OP_ROLES);
const MAX_TITLE_LENGTH = 128;
const MAX_DISPLAY_NAME_LENGTH = 128;

export class GroupOpPayloadV1 extends WirePayloadRecord {
  static KIND = GROUP_OP_KIND;
  static schema = {
    op: { type: "enum", values: [...GROUP_OPS], required: true },
    groupId: { type: "string", required: true, trim: true },
    actedAtMs: { type: "int", required: true },
    groupOpId: { type: "string", required: true, trim: true },
    // Op-specific fields — required-ness is enforced in validate() below.
    title: { type: "string", trim: true },
    accountId: { type: "string", trim: true },
    role: { type: "string", trim: false },
    channelId: { type: "string", trim: true, maxLength: 64 },
    // Free-form display label for channel.create; optional. Recipients persist
    // it on their ChatChannel record so the UI can show "#Dev Chat" instead
    // of "#dev-chat". Carries the user's original casing/spaces/emoji.
    label: { type: "string", trim: false, maxLength: 128 },
    // member.join authorization handle (inviter's invite-record id) +
    // optional display-name hint for the system-message rendering.
    inviteId: { type: "string", trim: true },
    displayName: { type: "string", trim: false, maxLength: MAX_DISPLAY_NAME_LENGTH },
  };

  validate() {
    super.validate();
    if (this.op === "rename" || this.op === "group.state") {
      this.assert(this.title.length > 0, `GroupOpPayloadV1.${this.op}: title required`);
      this.assert(this.title.length <= MAX_TITLE_LENGTH,
        `GroupOpPayloadV1.${this.op}: title exceeds ${MAX_TITLE_LENGTH} chars`);
    } else if (this.op === "kick" || this.op === "leave") {
      this.assert(this.accountId.length > 0, `GroupOpPayloadV1.${this.op}: accountId required`);
    } else if (this.op === "setRole") {
      this.assert(this.accountId.length > 0, "GroupOpPayloadV1.setRole: accountId required");
      this.assert(VALID_ROLES.has(this.role),
        `GroupOpPayloadV1.setRole: role must be one of ${GROUP_OP_ROLES.join("|")}, got '${this.role}'`);
    } else if (this.op === "channel.create" || this.op === "channel.delete") {
      this.assert(this.channelId.length > 0, `GroupOpPayloadV1.${this.op}: channelId required`);
      this.assert(CHANNEL_ID_PATTERN.test(this.channelId),
        `GroupOpPayloadV1.${this.op}: channelId must match ${CHANNEL_ID_PATTERN}, got '${this.channelId}'`);
    } else if (this.op === "member.join") {
      this.assert(this.accountId.length > 0, "GroupOpPayloadV1.member.join: accountId required");
      this.assert(this.inviteId.length > 0, "GroupOpPayloadV1.member.join: inviteId required");
    }
  }
}

export function groupOpPayloadToBytes(payload) {
  return new TextEncoder().encode(JSON.stringify(payload));
}
