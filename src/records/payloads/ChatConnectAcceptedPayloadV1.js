import { WirePayloadRecord } from "../WirePayloadRecord.js";

/**
 * ChatConnectAcceptedPayloadV1: a one-shot signal sent by the APPROVER of a
 * connect-request back to the REQUESTER the moment they approve. It exists so
 * the requester gets a real conversation with a starter "system" row even when
 * they never type anything — approval alone now materializes the DM on both
 * sides.
 *
 * Why a dedicated wire kind (and not ChatSystemEventPayloadV1 on the wire):
 * system-event rows are LOCALLY DERIVED on each side and never trusted off the
 * wire (a forged "member.join" must not be able to fabricate group history).
 * This payload preserves that invariant — it is a trusted *trigger*, and each
 * side persists its OWN ChatSystemEventPayloadV1("connect.accepted") row from
 * it, exactly like member.join derives its row from the authenticated group op.
 *
 * Delivery + authorization reuse the existing direct-content path:
 *   - It carries `senderAccountId` (the acceptor), so on the requester's node
 *     it flows through the same direct-content delivery gate a first DM would —
 *     which only lets it through when the requester actually has a pending
 *     OUTGOING connect-request to this peer (acceptance proof), and in doing so
 *     activates the contact and creates the requester's direct thread.
 *   - The dispatch handler then persists the requester-side system row into
 *     that freshly-resolved thread.
 *
 * It deliberately carries NO threadId: the requester's direct threadId is
 * derived from the peer-link on their side, not nameable by the sender.
 */
export const CONNECT_ACCEPTED_KIND = "rez.chat.connect-accepted.v1";

const MAX_DISPLAY_NAME_LENGTH = 128;

export class ChatConnectAcceptedPayloadV1 extends WirePayloadRecord {
  static KIND = CONNECT_ACCEPTED_KIND;
  static schema = {
    // The acceptor's account. Authoritative identity is still the sealed link
    // sender (ctx.peerAccountId / envelopeSender); this drives the direct-
    // content delivery gate and is the system row's actor.
    senderAccountId: { type: "string", required: true, trim: true },
    // Acceptor's display name, cached so the requester's system row reads
    // correctly before profile/contact data settles. Optional.
    acceptorDisplayName: { type: "string", trim: false, maxLength: MAX_DISPLAY_NAME_LENGTH },
    actedAtMs: { type: "int", required: true },
  };
}
