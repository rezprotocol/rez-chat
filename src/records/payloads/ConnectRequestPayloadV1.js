import { WirePayloadRecord } from "../WirePayloadRecord.js";

/**
 * ConnectRequestPayloadV1: an in-app request from one group co-member to
 * another asking to become direct (1:1) contacts. Delivered as a sealed
 * encrypted deposit over the requester's existing co-member peer-link — the
 * same channel group messages already flow on — so no out-of-band invite
 * code exchange is required.
 *
 * Unlike a plain DM invite (where handing someone a code IS the consent),
 * this request is initiated UNILATERALLY by the requester, so the recipient
 * gets an explicit approve/deny gate before any contact is created:
 *   - Approve → recipient runs the existing acceptInvite() X3DH path against
 *               `inviteCode`, minting a durable independent DM peer-link and
 *               creating the contact on BOTH sides (exactly as a normal
 *               invite acceptance does). The new DM link is independent of
 *               group membership and survives either party leaving the group.
 *   - Deny / ignore → recipient does nothing; the short-TTL invite carried by
 *               `inviteCode` simply expires. The requester is NOT told they
 *               were declined (silent expiry by design).
 *
 * `inviteCode` is produced by the requester via the normal createInvite()
 * path and carried here so the approver can accept it directly. The
 * requester's identity is authenticated by the sealed co-member link
 * (ctx.peerAccountId at dispatch); `requesterAccountId` is a display/dedup
 * hint only — the handler treats the link sender as authoritative.
 *
 * `groupId` records the originating group purely for UI context ("Alice from
 * Weekend Trip wants to connect"); it does NOT scope or authorize the
 * resulting contact, which is a standalone DM relationship.
 */
export const CONNECT_REQUEST_KIND = "rez.connect-request.v1";

const MAX_DISPLAY_NAME_LENGTH = 128;

export class ConnectRequestPayloadV1 extends WirePayloadRecord {
  static KIND = CONNECT_REQUEST_KIND;
  static schema = {
    // Correlation/idempotency id so a re-sent request collapses to one
    // pending row on the recipient and one pending state on the requester.
    requestId: { type: "string", required: true, trim: true },
    // Display/dedup hint for the requester. Authoritative sender identity is
    // the sealed co-member link (ctx.peerAccountId), cross-checked by the
    // handler — never trust this field for authorization.
    requesterAccountId: { type: "string", required: true, trim: true },
    // The requester's invite code (from createInvite). The approver passes
    // this straight to acceptInvite() to run X3DH and mint the DM peer-link.
    inviteCode: { type: "string", required: true, trim: true },
    // Originating group, for UI context only. Optional.
    groupId: { type: "string", trim: true },
    // Requester's chosen display name for the approve/deny prompt. Optional;
    // trim:false preserves casing/spaces/emoji.
    displayName: { type: "string", trim: false, maxLength: MAX_DISPLAY_NAME_LENGTH },
    createdAtMs: { type: "int", required: true },
  };
}
