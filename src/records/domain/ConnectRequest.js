import { RRecord } from "@rezprotocol/sdk/client";
import { nonEmptyString, toFiniteNumber } from "./coerce.js";

/**
 * ConnectRequest: the actionable, restart-surviving record of a pending
 * "connect" between two group co-members (see ConnectRequestPayloadV1). It is
 * the SSOT for the request lifecycle; the matching ChatContact row (in
 * `invited` relationshipState) is only the contact-list display reflection,
 * written by the same service so the two cannot drift.
 *
 *   - direction "outgoing": WE asked the peer to connect. We hold our own
 *     `inviteCode` for reference/dedup; resolution is automatic when the peer
 *     accepts (their X3DH handshake establishes our peer-link → the existing
 *     ServerEventService peer-link-established path flips our contact active).
 *   - direction "incoming": the peer asked US. `inviteCode` is THEIR code,
 *     which we pass to acceptInvite() on approval to run X3DH and mint the
 *     durable DM peer-link. On denial we silently drop the row; the short-TTL
 *     invite expires on the requester's side.
 *
 * `groupId` is the originating group, retained for UI context only — it does
 * not scope or authorize the resulting standalone DM contact.
 */
export const CONNECT_REQUEST_DIRECTIONS = Object.freeze(["outgoing", "incoming"]);
export const CONNECT_REQUEST_STATES = Object.freeze(["pending", "approved", "denied"]);
const VALID_DIRECTIONS = new Set(CONNECT_REQUEST_DIRECTIONS);
const VALID_STATES = new Set(CONNECT_REQUEST_STATES);

export function coerceConnectRequestDirection(value) {
  const text = nonEmptyString(value);
  if (!VALID_DIRECTIONS.has(text)) {
    throw new Error("ConnectRequest direction must be outgoing|incoming");
  }
  return text;
}

export function coerceConnectRequestState(value, fallback = "pending") {
  const text = nonEmptyString(value) || fallback;
  if (!VALID_STATES.has(text)) {
    throw new Error("ConnectRequest state must be pending|approved|denied");
  }
  return text;
}

function nullableString(value) {
  const text = nonEmptyString(value);
  return text || null;
}

export class ConnectRequest extends RRecord {
  static type = "chat.connectRequest";

  constructor(raw = {}) {
    super();
    this.peerAccountId = nonEmptyString(raw.peerAccountId);
    this.direction = coerceConnectRequestDirection(raw.direction);
    this.requestId = nonEmptyString(raw.requestId);
    this.inviteCode = nullableString(raw.inviteCode);
    this.displayName = nullableString(raw.displayName);
    this.groupId = nullableString(raw.groupId);
    this.state = coerceConnectRequestState(raw.state, "pending");
    const createdAtMs = toFiniteNumber(raw.createdAtMs, Date.now());
    this.createdAtMs = createdAtMs;
    this.updatedAtMs = toFiniteNumber(raw.updatedAtMs, createdAtMs);
    this._seal();
  }

  validate() {
    this.assert(this.peerAccountId.length > 0, "ConnectRequest requires peerAccountId");
    this.assert(this.requestId.length > 0, "ConnectRequest requires requestId");
    this.assert(
      this.direction !== "incoming" || (this.inviteCode && this.inviteCode.length > 0),
      "ConnectRequest(incoming) requires inviteCode",
    );
  }
}
