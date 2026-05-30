/**
 * Single owner of `sdk.subscriptions.onMailboxDeposited(...)` on the
 * chat-server. Forwards each push frame onto the chat bus as
 * `runtime.event.mailbox.deposited` with body `{ mailboxId, eventId,
 * ciphertextB64 }`.
 *
 * Wired in by ServerRuntimeService.connect() after the inbox claim
 * registers with the node. Both ServerEventService and
 * ServerPeerLinkProtocolService subscribe to the bus event instead of
 * the SDK directly so that the InboxCatchupService can emit on the same
 * bus event for missed deposits (deposits that landed in the relay's
 * inbox store while the owner's WS session was down) and reach both
 * subscribers through one path.
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
    const off = sdk.subscriptions.onMailboxDeposited((frame) => {
      try {
        bus.emit("runtime.event.mailbox.deposited", frame);
      } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        logger.error("[MailboxPushBridge] forward to bus failed: " + msg);
      }
    });
    return typeof off === "function" ? off : () => {};
  }
}
