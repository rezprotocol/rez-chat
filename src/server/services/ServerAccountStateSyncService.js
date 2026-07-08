import { BaseServerService } from "../base/BaseServerService.js";
import { AccountStateEventPayloadV1 } from "../../records/payloads/AccountStateEventPayloadV1.js";

/**
 * ServerAccountStateSyncService (S2.5 S14) — cross-device account-state sync. When
 * one device of an account mutates its relationship graph (adds/renames/removes a
 * contact, materializes a direct thread), it fans a sealed self-event out to its
 * SIBLING device inboxes so they converge — the account talking to itself.
 *
 * WHY: a sibling device that never took part in an invite already DECRYPTS a
 * peer's fanned-out message (its own per-device session), but ServerEventService's
 * isActiveContact gate drops it because the sibling has no `active` contact row.
 * Replicating that row (and the direct thread) makes the sibling SURFACE the
 * message. The peer-link RELATIONSHIP metadata a sibling needs to also REPLY is
 * carried on the same event and applied by the peer-link relationship apply (S14
 * L8). No crypto material replicates — each device keeps its own per-device ratchet
 * sessions (sharing a ratchet is the rejected S2.5 anti-pattern).
 *
 * Ordering: `lamport` is a per-ORIGIN-device monotonic counter (durable, so it
 * survives restart). The applier keeps the highest lamport seen per originDeviceId
 * and ignores replays/older events — last-writer-wins per origin device.
 *
 * Enabled only when this account runs per-device sessions (a device key) and the
 * SDK exposes the self fan-out primitives; otherwise every method no-ops, so
 * fs/legacy/web accounts are byte-identical.
 */
const LAMPORT_KEY_PREFIX = "app:account-state/lamport/"; // + ownerAccountId
const SEEN_KEY_PREFIX = "app:account-state/seen/"; // + originDeviceId

export class ServerAccountStateSyncService extends BaseServerService {
  #clock;
  #kv;
  #lamportChain;

  constructor({ bus, storageProvider, ownerAccountId, clock = () => Date.now(), logger = console } = {}) {
    super({ bus, ownerAccountId, logger });
    this.#clock = typeof clock === "function" ? clock : () => Date.now();
    this.#kv = storageProvider && typeof storageProvider.getKeyValueStore === "function"
      ? storageProvider.getKeyValueStore()
      : null;
    // Serializes lamport reads-modify-writes so two concurrent replicate() calls
    // never mint the same counter value.
    this.#lamportChain = Promise.resolve();
    this._register("account-state", "replicate", (payload) => this.replicate(payload || {}));
    this._register("account-state", "applyInbound", (payload) => this.applyInbound(payload || {}));
  }

  #sdk() {
    return this.bus.runtime && this.bus.runtime.sdk ? this.bus.runtime.sdk : null;
  }

  #peerLinks() {
    return this.bus.runtime && this.bus.runtime.peerLinks ? this.bus.runtime.peerLinks : null;
  }

  #deviceId() {
    const pl = this.#peerLinks();
    return pl && typeof pl.deviceId === "string" ? pl.deviceId.trim() : "";
  }

  // True when this account can FAN OUT self-events: the node advertises
  // multi-device fan-out (so siblings actually exist on a shared home) AND this
  // account runs per-device sessions with the SDK self-deposit primitives. Gated
  // on multiDeviceFanout like the sender fan-out, so single-device/fs/legacy nodes
  // are byte-identical (no emit, no getAccountDeviceSet call). applyInbound has a
  // lighter bar — a sibling always applies a self-event it received + decrypted.
  isEnabled() {
    const sdk = this.#sdk();
    return Boolean(
      this.bus.runtime && this.bus.runtime.multiDeviceFanout === true
        && this.#deviceId()
        && sdk
        && typeof sdk.buildAccountStateDeposit === "function"
        && typeof sdk.listSiblingDeviceInboxes === "function"
        && sdk.mesh && typeof sdk.mesh.dispatch === "function",
    );
  }

  async #nextLamport() {
    const key = LAMPORT_KEY_PREFIX + this.ownerAccountId;
    const run = this.#lamportChain.then(async () => {
      const stored = this.#kv ? await this.#kv.get(key) : null;
      const current = stored && Number.isInteger(stored.lamport) ? stored.lamport : 0;
      const next = current + 1;
      if (this.#kv) await this.#kv.set(key, { lamport: next });
      return next;
    });
    // Keep the chain alive even if this link rejects, so a later call still runs.
    this.#lamportChain = run.then(() => undefined, () => undefined);
    return run;
  }

  /**
   * Fan an account-state delta out to this account's sibling device inboxes.
   * Best-effort per sibling (a failed sibling does not fail the others).
   * @param {{op: string, payload: object}} delta
   * @returns {Promise<{fannedOut: number}>}
   */
  async replicate({ op, payload } = {}) {
    if (!this.isEnabled()) return { fannedOut: 0 };
    const sdk = this.#sdk();
    const originDeviceId = this.#deviceId();

    let siblings;
    try {
      siblings = await sdk.listSiblingDeviceInboxes();
    } catch (err) {
      this.logger.warn("[ServerAccountStateSyncService] listSiblingDeviceInboxes failed; skip replicate",
        err && err.message ? err.message : err);
      return { fannedOut: 0 };
    }
    if (!Array.isArray(siblings) || siblings.length === 0) return { fannedOut: 0 };

    const lamport = await this.#nextLamport();
    let event;
    try {
      event = new AccountStateEventPayloadV1({ op, lamport, originDeviceId, payload, issuedAtMs: this.#clock() });
    } catch (err) {
      this.logger.error("[ServerAccountStateSyncService] invalid account-state delta; not replicated",
        err && err.message ? err.message : err);
      return { fannedOut: 0 };
    }
    const plaintextBodyBytes = new TextEncoder().encode(JSON.stringify(event.toJSON()));

    let fannedOut = 0;
    for (const sibling of siblings) {
      const inboxId = sibling && typeof sibling.inboxId === "string" ? sibling.inboxId : "";
      if (!inboxId) continue;
      try {
        const deposit = await sdk.buildAccountStateDeposit({ deliverInboxId: inboxId, plaintextBodyBytes });
        await sdk.mesh.dispatch(deposit.object, deposit.address);
        fannedOut += 1;
      } catch (err) {
        this.logger.warn("[ServerAccountStateSyncService] account-state fan-out to sibling failed",
          err && err.message ? err.message : err);
      }
    }
    return { fannedOut };
  }

  /**
   * Apply a received account-state event idempotently (highest lamport per origin
   * device wins). Ignores our own emits and replays. @returns {Promise<{applied:boolean, reason?:string}>}
   */
  async applyInbound(rawEvent) {
    let event;
    try {
      event = rawEvent instanceof AccountStateEventPayloadV1 ? rawEvent : new AccountStateEventPayloadV1(rawEvent || {});
    } catch (err) {
      this.logger.warn("[ServerAccountStateSyncService] invalid inbound account-state event; dropping",
        err && err.message ? err.message : err);
      return { applied: false, reason: "invalid" };
    }

    // A device never applies its OWN emit (loop guard) — the fan-out excludes self,
    // but a mis-addressed replay must not be re-applied here either.
    const ownDeviceId = this.#deviceId();
    if (ownDeviceId && event.originDeviceId === ownDeviceId) {
      return { applied: false, reason: "self-origin" };
    }

    // Idempotency: highest lamport per origin device.
    const seenKey = SEEN_KEY_PREFIX + event.originDeviceId;
    const seenRec = this.#kv ? await this.#kv.get(seenKey) : null;
    const seen = seenRec && Number.isInteger(seenRec.lamport) ? seenRec.lamport : 0;
    if (event.lamport <= seen) {
      return { applied: false, reason: "stale" };
    }

    await this.#applyOp(event);

    if (this.#kv) await this.#kv.set(seenKey, { lamport: event.lamport });
    return { applied: true };
  }

  async #applyOp(event) {
    const p = event.payload && typeof event.payload === "object" ? event.payload : {};
    const services = this.bus.services || {};
    const contacts = services.contacts || null;
    const threads = services.threads || null;
    const now = this.#clock();

    if (event.op === "contact.remove") {
      if (contacts && typeof contacts.deleteContact === "function") {
        await contacts.deleteContact({ accountId: p.accountId });
      }
      return;
    }

    // contact.upsert — the workhorse. Materialize the contact row first (flips the
    // isActiveContact gate so a fanned-out peer message is accepted), then the
    // direct thread if the relationship fields are present.
    if (event.op === "contact.upsert") {
      const rel = typeof p.relationshipState === "string" ? p.relationshipState.trim().toLowerCase() : "";
      if (contacts) {
        if (rel === "active" && typeof contacts.ensureActiveContact === "function") {
          await contacts.ensureActiveContact({ accountId: p.accountId, displayName: p.displayName || "", lastSeenAtMs: now });
        } else if (typeof contacts.ensureKnownAccount === "function") {
          await contacts.ensureKnownAccount({ accountId: p.accountId, displayName: p.displayName || "" });
        }
      }
      // Record the peer-link RELATIONSHIP metadata (peer identity + routing, NO
      // ratchet) so the sibling can complete its OWN responder device session (and
      // thus DECRYPT this peer's fanned-out message) and later RESOLVE the peer's
      // device set to REPLY. The peerLinkId is the origin device's, so the derived
      // thread id matches across devices.
      const peerLinkId = typeof p.peerLinkId === "string" ? p.peerLinkId.trim() : "";
      const peerInboxId = typeof p.peerInboxId === "string" ? p.peerInboxId.trim() : "";
      const remoteAccountIdentityPublicKeyB64 = typeof p.remoteAccountIdentityPublicKeyB64 === "string" ? p.remoteAccountIdentityPublicKeyB64.trim() : "";
      const remoteIdentityDhPublicKeyB64 = typeof p.remoteIdentityDhPublicKeyB64 === "string" ? p.remoteIdentityDhPublicKeyB64.trim() : "";
      const peerLinks = this.#peerLinks();
      if (peerLinks && typeof peerLinks.upsertPeerRelationship === "function"
          && peerLinkId && peerInboxId && remoteAccountIdentityPublicKeyB64 && remoteIdentityDhPublicKeyB64) {
        try {
          await peerLinks.upsertPeerRelationship({
            peerAccountId: p.accountId,
            peerLinkId,
            peerInboxId,
            remoteAccountIdentityPublicKeyB64,
            remoteIdentityDhPublicKeyB64,
            nowMs: now,
          });
        } catch (err) {
          this.logger.warn("[ServerAccountStateSyncService] upsertPeerRelationship failed",
            err && err.message ? err.message : err);
        }
      }
      // Materialize the direct thread so the sibling has somewhere to surface the
      // peer's message.
      if (threads && peerLinkId && peerInboxId && typeof threads.ensureDirectThread === "function") {
        const threadId = typeof p.threadId === "string" && p.threadId.trim()
          ? p.threadId.trim()
          : (typeof threads.directThreadIdForPeerLink === "function" ? threads.directThreadIdForPeerLink(peerLinkId, p.accountId) : null);
        if (threadId) {
          await threads.ensureDirectThread({ threadId, peerAccountId: p.accountId, peerInboxId, createdAtMs: now });
        }
      }
      return;
    }

    this.logger.warn("[ServerAccountStateSyncService] unknown account-state op " + event.op);
  }
}
