import { SchemaRecord } from "../SchemaRecord.js";

/**
 * Emitted by InboxCatchupService when an inbound deposit is QUARANTINED — given
 * up on after repeated decrypt failures (the attempt or age bound, D1). A
 * quarantined deposit is genuinely undecryptable, so we know NOTHING about its
 * thread, sender, or content (that is all inside the ciphertext that failed
 * AES-GCM) — only the mailbox it arrived in, its durable `seq` (durable nodes) or
 * relay `eventId` (legacy nodes), and how hard we tried.
 *
 * This MUST be surfaced, never silently swallowed: dropping it (legacy: ack+delete;
 * durable: cursor-skip past the seq) advances us past mail we will never recover,
 * so the UI renders it as a "couldn't be delivered" failed-message notice (System
 * thread) instead of letting it disappear. See feedback_explicit_over_clever.
 */
export class MailboxDepositQuarantinedEvent extends SchemaRecord {
  static type = "chat.evt.mailbox_deposit_quarantined";
  static schema = {
    mailboxId: { type: "string", required: true, trim: true },
    // Durable nodes (S2) identify the deposit by per-inbox monotonic seq; legacy
    // nodes by the relay eventId. Exactly one is meaningful for a given event.
    seq: { type: "number", nullable: true },
    eventId: { type: "string", trim: true, nullable: true },
    // How hard we tried before giving up, and which bound fired.
    attempts: { type: "number", nullable: true },
    ageMs: { type: "number", nullable: true },
    reason: { type: "enum", values: ["attempts", "age"], required: true },
  };
}
