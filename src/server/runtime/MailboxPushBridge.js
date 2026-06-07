/**
 * Single owner of `sdk.subscriptions.onMailboxDeposited(...)` on the
 * chat-server. Feeds each live push frame `{ mailboxId, eventId,
 * ciphertextB64 }` into the serialized InboundDepositPipeline — the SAME path
 * the InboxCatchupService uses for missed deposits. Both sources share one
 * ordered pipeline so a burst (e.g. member.join immediately followed by a
 * message) is applied in order, never raced (it used to be a fire-and-forget
 * `bus.emit`, which let a message be dropped ahead of its membership op).
 *
 * Ack-on-success: once a pushed deposit is decrypted (or is a dedup hit), the
 * buffer copy is acked (`sdk.mailbox.ack`) so the relay buffer drains in steady
 * state instead of relying on the catch-up drain. A failed decrypt is NOT acked
 * — it is left for the catch-up drain to retry/quarantine (D1).
 *
 * Wired in by ServerRuntimeService.connect() after the inbox claim registers
 * with the node.
 *
 * Lifecycle: attach() returns an off-handle the caller invokes on
 * disconnect/stop to detach the SDK subscription.
 */
export class MailboxPushBridge {
  static attach({ sdk, bus, logger = console } = {}) {
    if (!sdk || !sdk.subscriptions || typeof sdk.subscriptions.onMailboxDeposited !== "function") {
      throw new Error("MailboxPushBridge.attach requires sdk.subscriptions.onMailboxDeposited");
    }
    if (!sdk.mailbox || typeof sdk.mailbox.ack !== "function") {
      throw new Error("MailboxPushBridge.attach requires sdk.mailbox.ack");
    }
    if (!bus || typeof bus.emit !== "function") {
      throw new Error("MailboxPushBridge.attach requires bus");
    }
    const pipeline = bus.services && bus.services.inboundPipeline;
    if (!pipeline || typeof pipeline.submit !== "function") {
      throw new Error("MailboxPushBridge.attach requires bus.services.inboundPipeline");
    }
    const off = sdk.subscriptions.onMailboxDeposited((frame) => {
      // Enqueue into the ORDERED queue, then ack the buffer copy once the deposit
      // resolves successfully. submit() logs + swallows handler errors internally
      // and resolves with a status object, so the sync guard only covers enqueue.
      let run;
      try {
        run = pipeline.submit(frame);
      } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        logger.error("[MailboxPushBridge] enqueue to inbound pipeline failed: " + msg);
        return;
      }
      Promise.resolve(run)
        .then((result) => {
          const ok = Boolean(result && (result.consumed || result.alreadyProcessed));
          const ids = MailboxPushBridge.#frameIds(frame);
          if (process.env.REZ_PEERLINK_TRACE === "1") {
            logger.log(
              "[PLTRACE] pushBridge evt=" + ids.eventId
              + " consumed=" + (result && result.consumed ? 1 : 0)
              + " decryptOk=" + (result && result.decryptOk ? 1 : 0)
              + " already=" + (result && result.alreadyProcessed ? 1 : 0)
              + " reason=" + (result && result.reason ? result.reason : "-")
              + " -> " + (ok ? "ACK" : "LEAVE"),
            );
          }
          if (!ok) return null;
          if (!ids.mailboxId || !ids.eventId) return null;
          return sdk.mailbox.ack({ mailboxId: ids.mailboxId, eventId: ids.eventId });
        })
        .catch((err) => {
          const msg = err && err.message ? err.message : String(err);
          logger.error("[MailboxPushBridge] post-submit ack failed: " + msg);
        });
    });
    return typeof off === "function" ? off : () => {};
  }

  static #frameIds(frame) {
    const body = frame && frame.body && typeof frame.body === "object" ? frame.body : (frame || {});
    const mailboxId = typeof body.mailboxId === "string" ? body.mailboxId : "";
    const eventId = typeof body.eventId === "string" ? body.eventId : "";
    return { mailboxId, eventId };
  }
}
