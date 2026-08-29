import { canonicalJSONStringify } from "@rezprotocol/sdk/client";
import { WirePayloadRecord } from "../WirePayloadRecord.js";

/**
 * SiblingSyncPayloadV1 (AE-2, plans/ORIGINAL_MESSAGE_ANTIENTROPY_PLAN.md §3):
 * the sealed sibling anti-entropy exchange over the SAME account-state AEAD
 * channel S14 uses (sibling-only sealing) — deliberately NOT the S14
 * AccountStateEventPayloadV1 (its 4KB payload cap and lamport stream are
 * wrong for bulk immutable records; sync is transient movement, never stored
 * as-is).
 *
 * Ops (the boring loop):
 *   digest       {threadId, messageCount, setDigest}  — announce a thread's
 *                fingerprint-set hash; equal digests end the exchange.
 *   inventory    {threadId, items:[{messageId, fingerprint}], replyToDigest}
 *                — the full listing. `messageId` is DIAGNOSTIC ONLY: the
 *                authoritative set math is over fingerprints (frozen —
 *                two facts sharing a messageId are two facts).
 *                replyToDigest=true marks the responder leg of a digest
 *                exchange; the receiver may answer with its OWN inventory
 *                (replyToDigest=false), which is terminal — no
 *                inventory→inventory loops.
 *   transfer     {threadId, facts:[OriginalMessage wire JSON]} — the missing
 *                signed records. Every fact is a NEW ADMISSION at the
 *                receiver (the sibling is transport, never authority).
 *   transferAck  {threadId, admittedFingerprints, deferredFingerprints}.
 *
 * Origin authentication mirrors S14 AF5/F2: the origin DEVICE signs the
 * body (sig over signableBytes) so a compromised sibling cannot impersonate
 * another origin device in sync control flow. The transferred FACTS carry
 * their own sender signatures and are verified independently at admission.
 */
export const SIBLING_SYNC_KIND = "rez.chat.sibling-sync.v1";

export const SIBLING_SYNC_OPS = Object.freeze(["digest", "inventory", "transfer", "transferAck"]);

// Bounds sized for mailbox deposit budgets: transfers batch (a text fact is
// ≤8KB text + chain), inventories are single-message (no reassembly state).
// A thread whose fact set exceeds INVENTORY_MAX_ITEMS is reported LOUDLY by
// the service and inventories its first (sorted) window — bounded, visible,
// never a silent cap.
export const TRANSFER_MAX_FACTS = 8;
export const INVENTORY_MAX_ITEMS = 2000;

export class SiblingSyncPayloadV1 extends WirePayloadRecord {
  static KIND = SIBLING_SYNC_KIND;
  static schema = {
    op: { type: "enum", values: [...SIBLING_SYNC_OPS], required: true },
    threadId: { type: "string", required: true, trim: true },
    // The self-cert deviceId + pubkey of the sibling device that sent this,
    // and its signature over signableBytes() (AF5/F2 discipline).
    originDeviceId: { type: "string", required: true, trim: true },
    originDevicePublicKeyB64: { type: "string", required: true, trim: true },
    issuedAtMs: { type: "int", required: true },
    // digest
    messageCount: { type: "int", nullable: true },
    setDigest: { type: "string", trim: true },
    // inventory
    items: { type: "array" },
    replyToDigest: { type: "boolean" },
    // transfer
    facts: { type: "array" },
    // transferAck
    admittedFingerprints: { type: "array" },
    deferredFingerprints: { type: "array" },
    sig: { type: "string", required: true, trim: true },
  };

  // The exact bytes the origin device signs and the receiver recomputes —
  // the body minus `sig`, canonicalized. `messageCount` is normalized to an
  // integer (absent/null → 0) because the schema's int coercion maps null →
  // 0 on the receive side; without one normalization here the sender and
  // receiver would canonicalize DIFFERENT bytes for every non-digest op.
  static signableBytes({
    op,
    threadId,
    originDeviceId,
    originDevicePublicKeyB64,
    issuedAtMs,
    messageCount = null,
    setDigest = "",
    items = [],
    replyToDigest = false,
    facts = [],
    admittedFingerprints = [],
    deferredFingerprints = [],
  } = {}) {
    return new TextEncoder().encode(canonicalJSONStringify({
      kind: SIBLING_SYNC_KIND,
      op,
      threadId,
      originDeviceId,
      originDevicePublicKeyB64,
      issuedAtMs,
      messageCount: Number.isInteger(messageCount) ? messageCount : 0,
      setDigest,
      items,
      replyToDigest,
      facts,
      admittedFingerprints,
      deferredFingerprints,
    }));
  }

  validate() {
    super.validate();
    this.assert(
      typeof this.originDeviceId === "string" && this.originDeviceId.startsWith("rez:dev:"),
      "SiblingSyncPayloadV1.originDeviceId must be a rez:dev: id",
    );
    if (this.op === "digest") {
      this.assert(Number.isInteger(this.messageCount) && this.messageCount >= 0,
        "SiblingSyncPayloadV1 digest requires messageCount >= 0");
      this.assert(this.setDigest.length > 0, "SiblingSyncPayloadV1 digest requires setDigest");
    }
    if (this.op === "inventory") {
      this.assert(this.items.length <= INVENTORY_MAX_ITEMS,
        "SiblingSyncPayloadV1 inventory exceeds " + INVENTORY_MAX_ITEMS + " items");
      for (const item of this.items) {
        this.assert(item && typeof item === "object"
          && typeof item.fingerprint === "string" && item.fingerprint.length > 0,
          "SiblingSyncPayloadV1 inventory items require a fingerprint");
      }
    }
    if (this.op === "transfer") {
      this.assert(this.facts.length > 0 && this.facts.length <= TRANSFER_MAX_FACTS,
        "SiblingSyncPayloadV1 transfer requires 1.." + TRANSFER_MAX_FACTS + " facts");
      for (const fact of this.facts) {
        this.assert(fact && typeof fact === "object" && !Array.isArray(fact),
          "SiblingSyncPayloadV1 transfer facts must be objects");
      }
    }
    if (this.op === "transferAck") {
      for (const list of [this.admittedFingerprints, this.deferredFingerprints]) {
        for (const fp of list) {
          this.assert(typeof fp === "string" && fp.length > 0,
            "SiblingSyncPayloadV1 transferAck fingerprints must be non-empty strings");
        }
      }
    }
  }
}
