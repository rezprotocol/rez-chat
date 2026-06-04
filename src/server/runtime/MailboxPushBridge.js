/**
 * Single owner of `sdk.subscriptions.onMailboxDeposited(...)` on the
 * chat-server. Feeds each live push frame `{ mailboxId, eventId,
 * ciphertextB64 }` into the serialized InboundDepositPipeline — the SAME path
 * the InboxCatchupService uses for missed deposits. Both sources share one
 * ordered pipeline so a burst (e.g. member.join immediately followed by a
 * message) is applied in order, never raced (it used to be a fire-and-forget
 * `bus.emit`, which let a message be dropped ahead of its membership op).
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
    if (!bus || typeof bus.emit !== "function") {
      throw new Error("MailboxPushBridge.attach requires bus");
    }
    const pipeline = bus.services && bus.services.inboundPipeline;
    if (!pipeline || typeof pipeline.submit !== "function") {
      throw new Error("MailboxPushBridge.attach requires bus.services.inboundPipeline");
    }
    const off = sdk.subscriptions.onMailboxDeposited((frame) => {
      // Fire-and-forget into the ORDERED queue: submit() enqueues behind any
      // in-flight deposit and returns immediately; it logs + swallows handler
      // errors internally, so the guard only covers the synchronous enqueue.
      try {
        pipeline.submit(frame);
      } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        logger.error("[MailboxPushBridge] enqueue to inbound pipeline failed: " + msg);
      }
    });
    return typeof off === "function" ? off : () => {};
  }
}
