import { WirePayloadRecord } from "../WirePayloadRecord.js";

/**
 * AccountStateEventPayloadV1 (S2.5 S14) — a self-replication event one device of
 * an account fans out to its SIBLING devices' inboxes so they converge on the
 * account's relationship graph (contacts, peer-link relationship metadata, direct
 * threads). It is the account "talking to itself" across devices.
 *
 * WHY it exists: a sibling device that never took part in an invite already
 * DECRYPTS a peer's fanned-out message (its own per-device session), but
 * ServerEventService's `isActiveContact` gate drops it because the sibling has no
 * `active` contact row. This event replicates that row (and the peer-link
 * relationship metadata a sibling needs to REPLY) — NOT any crypto material. Each
 * device keeps its OWN per-device ratchet sessions; sharing a ratchet across
 * devices is the rejected S2.5 anti-pattern. Only the metadata graph replicates.
 *
 * GATE BYPASS: this payload deliberately carries NO `senderAccountId` and NO
 * `threadId`. ServerEventService's direct-content `isActiveContact` gate only runs
 * on the `!thread && payloadSender` branch, so a thread-less, sender-less payload
 * skips it and reaches the PAYLOAD_KIND_REGISTRY dispatch (like connect-request).
 * The sealed-deposit crypto (account-state AEAD, sibling-only) is the authority:
 * only a device holding the account keys can produce a deposit that opens.
 *
 * ORDERING: `lamport` is a per-ORIGIN-device monotonic counter; the applier keeps
 * the highest lamport seen per originDeviceId and ignores replays/older events
 * (last-writer-wins per origin device — no cross-device merge beyond that).
 *
 * `op` is the delta verb; `payload` is op-tagged. `contact.upsert` is the workhorse:
 * a single atomic event that carries the whole direct relationship, so a sibling
 * materializes contact + peer-link relationship + thread with NO cross-event
 * ordering fragility. It covers add / rename / block via relationshipState +
 * displayName; `contact.remove` covers delete.
 *   contact.upsert → { accountId, relationshipState, displayName?,
 *                      peerInboxId?, peerLinkId?, threadId? }
 *                    (the optional peerInboxId+peerLinkId+threadId let the sibling
 *                     record the peer-link RELATIONSHIP metadata — not the ratchet —
 *                     so it can also REPLY, and materialize the direct thread)
 *   contact.remove → { accountId }
 */
export const ACCOUNT_STATE_EVENT_KIND = "rez.account.state.v1";

export const ACCOUNT_STATE_OPS = Object.freeze([
  "contact.upsert",
  "contact.remove",
]);

// The op-tagged payload's required string fields. Keeps the record honest without
// duplicating the graph model — the sync service interprets the values. The
// relationship fields on contact.upsert are OPTIONAL (a rename carries only a name).
const OP_REQUIRED_FIELDS = Object.freeze({
  "contact.upsert": ["accountId", "relationshipState"],
  "contact.remove": ["accountId"],
});

const MAX_PAYLOAD_JSON_BYTES = 4096;

export class AccountStateEventPayloadV1 extends WirePayloadRecord {
  static KIND = ACCOUNT_STATE_EVENT_KIND;
  static schema = {
    op: { type: "enum", values: ACCOUNT_STATE_OPS, required: true },
    // Per-origin-device monotonic counter (>0). Highest-wins per originDeviceId.
    lamport: { type: "int", required: true },
    // The self-cert deviceId of the device that ORIGINATED this delta.
    originDeviceId: { type: "string", required: true, trim: true },
    // Op-tagged delta content (see class doc). Bounded to keep self-fan-out cheap.
    payload: { type: "object", required: true, maxJsonBytes: MAX_PAYLOAD_JSON_BYTES },
    issuedAtMs: { type: "int", required: true },
  };

  validate() {
    super.validate();
    this.assert(
      typeof this.originDeviceId === "string" && this.originDeviceId.startsWith("rez:dev:"),
      "AccountStateEventPayloadV1.originDeviceId must be a rez:dev: id",
    );
    const required = OP_REQUIRED_FIELDS[this.op] || [];
    const payload = this.payload && typeof this.payload === "object" ? this.payload : {};
    for (const field of required) {
      this.assert(
        typeof payload[field] === "string" && payload[field].length > 0,
        `AccountStateEventPayloadV1 ${this.op} payload.${field} must be a non-empty string`,
      );
    }
  }
}
