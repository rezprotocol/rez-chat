/**
 * Canonical identity for a mailbox-deposit frame.
 *
 * Durable home events are stable by per-inbox sequence and may omit the
 * transient relay eventId during catch-up. Use the same `seq:<n>` identity for
 * live delivery, catch-up, decrypt dedup, and application persistence.
 */
export function depositIdentity(frame) {
  const body = frame && frame.body && typeof frame.body === "object" ? frame.body : (frame || {});
  const mailboxId = typeof body.mailboxId === "string" ? body.mailboxId.trim() : "";
  const transientEventId = typeof body.eventId === "string" ? body.eventId.trim() : "";
  const seq = Number.isInteger(body.seq) && body.seq >= 0 ? body.seq : null;
  const eventId = seq !== null ? "seq:" + seq : transientEventId;
  return { mailboxId, eventId, seq, dedupId: eventId };
}
