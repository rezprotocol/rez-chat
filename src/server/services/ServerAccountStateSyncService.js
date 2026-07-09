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
const PENDING_KEY_PREFIX = "app:account-state/pending/"; // + inboxId + ":" + lamport
const MAX_SEND_ATTEMPTS = 8;

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
    // AF6b: retry account-state sends that failed to dispatch (sender was offline).
    this._register("account-state", "flushPending", () => this.flushPending());
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

    const peerLinks = this.#peerLinks();
    const originDevicePublicKeyB64 = peerLinks && typeof peerLinks.devicePublicKeyB64 === "string" ? peerLinks.devicePublicKeyB64 : "";
    if (!originDevicePublicKeyB64 || typeof peerLinks.signAccountStateEvent !== "function") {
      this.logger.warn("[ServerAccountStateSyncService] no device key to sign the account-state event; skip replicate");
      return { fannedOut: 0 };
    }
    const lamport = await this.#nextLamport();
    const issuedAtMs = this.#clock();
    // AF5/F2: sign the event body with THIS device's key so a sibling can verify
    // WHICH origin device authored it (the AEAD only proves SOME account device did).
    let sig;
    try {
      const signable = AccountStateEventPayloadV1.signableBytes({ op, lamport, originDeviceId, originDevicePublicKeyB64, payload, issuedAtMs });
      const signed = await peerLinks.signAccountStateEvent(signable);
      sig = signed && typeof signed.sigB64 === "string" ? signed.sigB64 : "";
    } catch (err) {
      this.logger.error("[ServerAccountStateSyncService] account-state event signing failed; not replicated",
        err && err.message ? err.message : err);
      return { fannedOut: 0 };
    }
    let event;
    try {
      event = new AccountStateEventPayloadV1({ op, lamport, originDeviceId, originDevicePublicKeyB64, payload, issuedAtMs, sig });
    } catch (err) {
      this.logger.error("[ServerAccountStateSyncService] invalid account-state delta; not replicated",
        err && err.message ? err.message : err);
      return { fannedOut: 0 };
    }
    const plaintextBodyBytes = new TextEncoder().encode(JSON.stringify(event.toJSON()));

    const eventJson = event.toJSON();
    let fannedOut = 0;
    for (const sibling of siblings) {
      const inboxId = sibling && typeof sibling.inboxId === "string" ? sibling.inboxId : "";
      if (!inboxId) continue;
      try {
        const deposit = await sdk.buildAccountStateDeposit({ deliverInboxId: inboxId, plaintextBodyBytes });
        await sdk.mesh.dispatch(deposit.object, deposit.address);
        fannedOut += 1;
      } catch (err) {
        // AF6b/Finding 3: a failed dispatch (e.g. sender offline) is not silently
        // lost — persist it for retry on reconnect. Re-dispatching the SAME signed
        // event is idempotent at the sibling (verified sig + highest-lamport-wins).
        this.logger.warn("[ServerAccountStateSyncService] account-state fan-out to sibling failed; queued for retry",
          err && err.message ? err.message : err);
        await this.#stashPending(inboxId, eventJson);
      }
    }
    return { fannedOut };
  }

  async #stashPending(inboxId, eventJson) {
    if (!this.#kv) return;
    const key = PENDING_KEY_PREFIX + inboxId + ":" + eventJson.lamport;
    try {
      await this.#kv.set(key, { inboxId, eventJson, attempts: 0 });
    } catch (err) {
      this.logger.error("[ServerAccountStateSyncService] failed to persist pending account-state send",
        err && err.message ? err.message : err);
    }
  }

  /**
   * Retry account-state sends that previously failed to dispatch (the sender was
   * offline when the delta was minted). Called on (re)connect. Each retry re-seals +
   * re-dispatches the SAME signed event — idempotent at the sibling. Drops an entry
   * after MAX_SEND_ATTEMPTS (poison bound) with a loud log. @returns {Promise<{flushed, dropped}>}
   */
  async flushPending() {
    if (!this.isEnabled() || !this.#kv) return { flushed: 0, dropped: 0 };
    const sdk = this.#sdk();
    let keys;
    try {
      keys = await this.#kv.keys(PENDING_KEY_PREFIX);
    } catch (err) {
      this.logger.warn("[ServerAccountStateSyncService] flushPending: keys() failed", err && err.message ? err.message : err);
      return { flushed: 0, dropped: 0 };
    }
    let flushed = 0;
    let dropped = 0;
    for (const key of keys) {
      const rec = await this.#kv.get(key);
      if (!rec || typeof rec !== "object" || !rec.inboxId || !rec.eventJson) {
        await this.#kv.delete(key);
        continue;
      }
      try {
        const bytes = new TextEncoder().encode(JSON.stringify(rec.eventJson));
        const deposit = await sdk.buildAccountStateDeposit({ deliverInboxId: rec.inboxId, plaintextBodyBytes: bytes });
        await sdk.mesh.dispatch(deposit.object, deposit.address);
        await this.#kv.delete(key);
        flushed += 1;
      } catch (err) {
        const attempts = (Number.isInteger(rec.attempts) ? rec.attempts : 0) + 1;
        if (attempts >= MAX_SEND_ATTEMPTS) {
          await this.#kv.delete(key);
          dropped += 1;
          this.logger.error("[ServerAccountStateSyncService] dropping undeliverable account-state send after "
            + MAX_SEND_ATTEMPTS + " attempts (inbox " + rec.inboxId + ")", err && err.message ? err.message : err);
        } else {
          await this.#kv.set(key, { ...rec, attempts });
        }
      }
    }
    return { flushed, dropped };
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

    // AF5/F2: verify the ORIGIN-DEVICE signature BEFORE trusting originDeviceId or
    // lamport. The AEAD only proves SOME account device authored this; the signature
    // (self-cert deviceId + sig over the body) proves WHICH one — so a single
    // compromised sibling cannot forge an event attributed to an honest origin device
    // (and thus cannot poison that origin's lamport stream or impersonate it).
    // Fail-closed: no verifier, or a bad signature, drops the event.
    const peerLinks = this.#peerLinks();
    if (!peerLinks || typeof peerLinks.verifyAccountStateEventSig !== "function") {
      this.logger.error("[ServerAccountStateSyncService] cannot verify account-state signature (no verifier); dropping");
      return { applied: false, reason: "unverifiable" };
    }
    const signable = AccountStateEventPayloadV1.signableBytes({
      op: event.op, lamport: event.lamport, originDeviceId: event.originDeviceId,
      originDevicePublicKeyB64: event.originDevicePublicKeyB64, payload: event.payload, issuedAtMs: event.issuedAtMs,
    });
    const sigOk = await peerLinks.verifyAccountStateEventSig({
      signableBytes: signable, originDeviceId: event.originDeviceId,
      originDevicePublicKeyB64: event.originDevicePublicKeyB64, sigB64: event.sig,
    });
    if (!sigOk) {
      this.logger.warn("[ServerAccountStateSyncService] account-state event failed origin-device signature; dropping");
      return { applied: false, reason: "bad-signature" };
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

    const applied = await this.#applyOp(event);

    // Advance the idempotency cursor ONLY on a FULL apply. A partial apply (e.g. the
    // load-bearing peer-link relationship write faulted) must NOT advance seen — else
    // the sibling is stranded with an active contact but no way to decrypt the peer's
    // message, and the event can never be re-applied. Leaving seen put lets a
    // re-materialization (a fresh, higher-lamport delta) heal it.
    if (!applied) {
      return { applied: false, reason: "apply-incomplete" };
    }
    if (this.#kv) await this.#kv.set(seenKey, { lamport: event.lamport });
    return { applied: true };
  }

  // Apply an event's op. Returns true only when EVERY load-bearing step succeeded
  // (so applyInbound can gate the seen-cursor on it). The peer-link relationship is
  // load-bearing (without it the sibling cannot complete a responder session to
  // decrypt the peer's message), so it is written FIRST and a failure aborts BEFORE
  // the contact is activated — never open the isActiveContact gate for a message we
  // then cannot decrypt.
  async #applyOp(event) {
    const p = event.payload && typeof event.payload === "object" ? event.payload : {};
    const services = this.bus.services || {};
    const contacts = services.contacts || null;
    const threads = services.threads || null;
    const now = this.#clock();

    if (event.op === "contact.remove") {
      if (contacts && typeof contacts.deleteContact === "function") {
        // fromSync: applying a replicated removal must NOT re-replicate (loop guard).
        // The sibling runs its own demote-or-delete against its own co-membership view.
        await contacts.deleteContact({ accountId: p.accountId, fromSync: true });
      }
      return true;
    }

    if (event.op === "contact.upsert") {
      // 1) Peer-link RELATIONSHIP metadata FIRST (peer identity + routing, NO ratchet)
      // so the sibling can complete its OWN responder device session (and thus DECRYPT
      // this peer's fanned-out message) and later RESOLVE the peer's device set to
      // REPLY. The peerLinkId is the origin device's, so the derived thread id matches
      // across devices. A failure here fails LOUD and aborts the whole apply (seen is
      // not advanced), rather than the old swallow-and-advance that stranded the sibling.
      const peerLinkId = typeof p.peerLinkId === "string" ? p.peerLinkId.trim() : "";
      const peerInboxId = typeof p.peerInboxId === "string" ? p.peerInboxId.trim() : "";
      const remoteAccountIdentityPublicKeyB64 = typeof p.remoteAccountIdentityPublicKeyB64 === "string" ? p.remoteAccountIdentityPublicKeyB64.trim() : "";
      const remoteIdentityDhPublicKeyB64 = typeof p.remoteIdentityDhPublicKeyB64 === "string" ? p.remoteIdentityDhPublicKeyB64.trim() : "";
      const peerLinks = this.#peerLinks();
      // FU3 (Finding 5): the peer-link relationship + direct thread are ONLY usable
      // by a device that runs per-device sessions (has a device key). A device
      // without one could open+apply an account-state event but could never decrypt
      // the peer's message — so skip the relationship+thread it can't use and apply
      // only the contact (name-only value). Normal device-bearing siblings are
      // unaffected.
      const hasDeviceSessions = Boolean(this.#deviceId());
      const hasRelationship = peerLinkId && peerInboxId && remoteAccountIdentityPublicKeyB64 && remoteIdentityDhPublicKeyB64;
      if (hasDeviceSessions && peerLinks && typeof peerLinks.upsertPeerRelationship === "function" && hasRelationship) {
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
          // Load-bearing: without the relationship the sibling cannot decrypt the
          // peer's message. Fail the whole apply (seen not advanced) so it is not
          // silently dropped; do NOT open the contact gate below.
          this.logger.error("[ServerAccountStateSyncService] peer-link relationship write failed; aborting apply (will heal on re-materialization)",
            err && err.message ? err.message : err);
          return false;
        }
      }

      // 2) Now the contact row (flips the isActiveContact gate) — only reached once
      // the relationship the decrypt depends on is in place.
      const rel = typeof p.relationshipState === "string" ? p.relationshipState.trim().toLowerCase() : "";
      if (contacts) {
        if (rel === "active" && typeof contacts.ensureActiveContact === "function") {
          await contacts.ensureActiveContact({ accountId: p.accountId, displayName: p.displayName || "", lastSeenAtMs: now });
        } else if (typeof contacts.ensureKnownAccount === "function") {
          await contacts.ensureKnownAccount({ accountId: p.accountId, displayName: p.displayName || "" });
        }
      }
      // 3) The direct thread (record + conversation-list index row) so the sibling
      // has somewhere to surface the peer's message — mirroring the inviter-side
      // materialization in #handlePeerLinkUpdated, so the thread shows before any
      // message arrives.
      if (hasDeviceSessions && threads && peerLinkId && peerInboxId && typeof threads.ensureDirectThread === "function") {
        const threadId = typeof p.threadId === "string" && p.threadId.trim()
          ? p.threadId.trim()
          : (typeof threads.directThreadIdForPeerLink === "function" ? threads.directThreadIdForPeerLink(peerLinkId, p.accountId) : null);
        if (threadId) {
          await threads.ensureDirectThread({ threadId, peerAccountId: p.accountId, peerInboxId, createdAtMs: now });
          const threadIndex = this.bus.stores && this.bus.stores.threadIndex ? this.bus.stores.threadIndex : null;
          if (threadIndex && typeof threadIndex.upsertFromMessage === "function") {
            const record = await threadIndex.upsertFromMessage({ threadId, messageId: null, ts: now, preview: "Connected" })
              .catch((err) => { this.logger.warn("[ServerAccountStateSyncService] thread index upsert failed", err && err.message ? err.message : err); return null; });
            if (record && typeof threads.emitThreadIndexUpdated === "function") threads.emitThreadIndexUpdated(record);
          }
        }
      }
      return true;
    }

    this.logger.warn("[ServerAccountStateSyncService] unknown account-state op " + event.op);
    return false;
  }
}
