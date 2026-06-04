import { BaseServerService } from "../base/BaseServerService.js";
import { InboxCatchupCursor } from "../inbox/InboxCatchupCursor.js";

const DEFAULT_PAGE_LIMIT = 50;

/**
 * On chat-server start (and on every SDK transport reconnect), pull any
 * mailbox events that landed in the relay's inbox store while this owner
 * had no active WS session. For each new event, fetch the ciphertext and
 * re-emit on the chat bus as `runtime.event.mailbox.deposited` — the
 * same shape the live SDK push uses — so existing ServerEventService and
 * ServerPeerLinkProtocolService subscribers process catchup items
 * through their normal handler paths.
 *
 * Persisted cursor: per-inbox high-water-mark advanced after each
 * successful dispatch. Re-dispatch on crash is safe because downstream
 * persistence is canonical-key idempotent (messageId, groupOpId, ...).
 */
export class InboxCatchupService extends BaseServerService {
  #cursor;
  #inboxClaimant;
  #pageLimit;
  #draining;
  #pending;
  #offReconnect;
  #pipeline;

  constructor({ bus, storageProvider, inboxClaimant, inboundPipeline, pageLimit = DEFAULT_PAGE_LIMIT, logger = console } = {}) {
    super({ bus, logger });
    if (!storageProvider || typeof storageProvider.getKeyValueStore !== "function") {
      throw new Error("InboxCatchupService requires storageProvider");
    }
    if (!inboxClaimant) {
      throw new Error("InboxCatchupService requires inboxClaimant");
    }
    if (!inboundPipeline || typeof inboundPipeline.submit !== "function") {
      throw new Error("InboxCatchupService requires inboundPipeline.submit");
    }
    this.#cursor = new InboxCatchupCursor({ kvStore: storageProvider.getKeyValueStore(null) });
    this.#inboxClaimant = inboxClaimant;
    this.#pipeline = inboundPipeline;
    this.#pageLimit = Number.isInteger(pageLimit) && pageLimit > 0 ? pageLimit : DEFAULT_PAGE_LIMIT;
    this.#draining = false;
    this.#pending = false;
    this.#offReconnect = null;
  }

  async start() {
    const sdk = this.bus.runtime && this.bus.runtime.sdk ? this.bus.runtime.sdk : null;
    if (!sdk || !sdk.connectivity || typeof sdk.connectivity.onReconnected !== "function") {
      throw new Error("InboxCatchupService requires sdk.connectivity.onReconnected");
    }
    this.#offReconnect = sdk.connectivity.onReconnected(() => {
      this.requestDrain().catch((err) => {
        this.logger.error("[InboxCatchupService] reconnect drain failed: " + (err && err.message ? err.message : err));
      });
    });
    await this.requestDrain();
  }

  async stop() {
    if (typeof this.#offReconnect === "function") {
      try {
        this.#offReconnect();
      } catch (err) {
        this.logger.error("[InboxCatchupService] reconnect unsubscribe failed: " + (err && err.message ? err.message : err));
      }
      this.#offReconnect = null;
    }
    await super.stop();
  }

  /**
   * Coalesce concurrent drain requests: if a drain is already in flight,
   * mark pending and let the in-flight loop run one more pass before
   * resolving. Prevents two reconnects (or start+reconnect) from
   * fan-out-listing in parallel.
   */
  async requestDrain() {
    if (this.#draining) {
      this.#pending = true;
      return;
    }
    this.#draining = true;
    try {
      do {
        this.#pending = false;
        await this.#drainOnce();
      } while (this.#pending);
    } finally {
      this.#draining = false;
    }
    // Readiness signal (a true notification — emit is correct here): the inbox
    // is now fully drained and every missed deposit has been APPLIED (the drain
    // awaits each through the serialized pipeline). Emitted under the bare bridge
    // spec key so the transport forwards it to the UI as
    // `runtime.event.inbox.caughtup`; the UI gates "show real state" on it so
    // login never asserts the stale pre-catch-up snapshot.
    this._emit("inbox.caughtup", { mailboxId: this.#inboxClaimant.inboxId });
  }

  async #drainOnce() {
    const sdk = this.bus.runtime && this.bus.runtime.sdk ? this.bus.runtime.sdk : null;
    if (!sdk || !sdk.mailbox || typeof sdk.mailbox.list !== "function" || typeof sdk.mailbox.fetch !== "function") {
      throw new Error("InboxCatchupService requires sdk.mailbox.list/fetch");
    }
    const mailboxId = this.#inboxClaimant.inboxId;
    if (typeof mailboxId !== "string" || mailboxId.length === 0) {
      throw new Error("InboxCatchupService: inboxClaimant.inboxId is not set");
    }

    let cursor = await this.#cursor.read(mailboxId);
    while (true) {
      const page = await sdk.mailbox.list({ mailboxId, cursor, limit: this.#pageLimit });
      const items = page && Array.isArray(page.items) ? page.items : [];
      if (process.env.REZ_INBOX_CATCHUP_DEBUG === "1") {
        this.logger.log("[InboxCatchupService] mailbox.list mailboxId=" + mailboxId + " cursor=" + (cursor || "null") + " items=" + items.length + " nextCursor=" + (page && page.nextCursor ? page.nextCursor : "null"));
      }
      if (items.length === 0) {
        return;
      }
      for (const item of items) {
        const eventId = item && typeof item.eventId === "string" ? item.eventId : "";
        if (!eventId) continue;
        const fetched = await sdk.mailbox.fetch({ mailboxId, eventId });
        const ciphertextB64 = fetched && typeof fetched.ciphertextB64 === "string" ? fetched.ciphertextB64 : "";
        const frame = {
          t: "evt.mailbox.deposited",
          body: { mailboxId, eventId, ciphertextB64 },
        };
        // Directive, not a notification: process this deposit to FULL COMPLETION
        // (decrypt → apply membership/message, in order) before advancing the
        // cursor or touching the next deposit. The serialized pipeline guarantees
        // a member.join is applied before any message that depends on it.
        await this.#pipeline.submit(frame);
        await this.#cursor.write(mailboxId, eventId);
        cursor = eventId;
      }
      const nextCursor = page && typeof page.nextCursor === "string" ? page.nextCursor : null;
      if (!nextCursor) return;
      cursor = nextCursor;
    }
  }
}
