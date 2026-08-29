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
const RECONCILE_AT_KEY = "app:account-state/reconcile-at";
const RECONCILE_MIN_INTERVAL_MS = 5 * 60 * 1000;

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
    // FU4: full-state anti-entropy — re-replicate all active contacts to siblings
    // (throttled) so a sibling that missed deltas entirely converges.
    this._register("account-state", "reconcile", () => this.reconcileToSiblings());
    // Device activation (plans/DEVICE_ACTIVATION_PLAN.md): the baseline is a
    // targeted, UNTHROTTLED full-state reconcile terminated by an
    // activation-bound completion marker; the request is the BOOTSTRAPPING
    // device's per-sync liveness re-ask (recovery, never completeness).
    this._register("account-state", "sendActivationBaseline", (payload) => this.sendActivationBaseline(payload || {}));
    this._register("account-state", "requestActivationBaseline", (payload) => this.requestActivationBaseline(payload || {}));
    // M4: recompute bus.runtime.accountMultiDevice from durable state (roster
    // + verified authority) — called at claimant bind and from wake converge.
    this._register("account-state", "refreshAccountMultiDevice", () => this.refreshAccountMultiDevice());
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
    // M4 (plan §7b): "does this account have multiple active devices?"
    // (accountMultiDevice, durable-state-derived) is a DIFFERENT question
    // from "does this session's home advertise E6 fan-out?"
    // (multiDeviceFanout, per-connection). Sibling machinery runs under
    // EITHER: the legacy home-capability path is byte-identical, and a
    // claimant session with a multi-device account now participates in
    // sibling convergence. accountMultiDevice may enable data-plane work
    // ONLY — nothing downstream of this gate may express account authority.
    const accountMultiDevice = Boolean(this.bus.runtime && this.bus.runtime.accountMultiDevice === true);
    const homeFanout = Boolean(this.bus.runtime && this.bus.runtime.multiDeviceFanout === true);
    return Boolean(
      (homeFanout || accountMultiDevice)
        && this.#deviceId()
        && sdk
        && typeof sdk.buildAccountStateDeposit === "function"
        && typeof sdk.listSiblingDeviceInboxes === "function"
        && sdk.mesh && typeof sdk.mesh.dispatch === "function",
    );
  }

  #rosterStore() {
    return this.bus.stores && this.bus.stores.deviceRosterStore ? this.bus.stores.deviceRosterStore : null;
  }

  /**
   * M4: recompute `bus.runtime.accountMultiDevice` from durable state — the
   * last-known roster composed with the CURRENT verified authority state
   * (both read entirely on the data plane). Called at claimant bind and from
   * wake convergence; account-legacy runtimes never need it (their sibling
   * gate is the home capability, unchanged).
   * @returns {Promise<{accountMultiDevice: boolean, reason: string}>}
   */
  async refreshAccountMultiDevice() {
    const resolved = await this.#effectiveSiblingState();
    const on = resolved.established && Array.isArray(resolved.activeDevices) && resolved.activeDevices.length > 1;
    this.bus.runtime.accountMultiDevice = on;
    return { accountMultiDevice: on, reason: resolved.reason };
  }

  /**
   * The frozen M4 security rule, in one place:
   *
   *   effectiveActiveDevices = lastKnownRoster
   *                            GATED by current verified authority state
   *
   * The roster snapshot came from the home's registry-JOINed ACTIVE read at
   * `roster.epoch`, so AT that epoch it already excludes everything revoked.
   * Revocations are cert-scoped while roster rows are device-scoped, so a
   * per-device subtraction is not derivable on the data plane — but every
   * authority mutation bumps the monotonic epoch, so the gate is:
   *
   *   verified epoch <= roster.epoch → membership unchanged since the
   *       snapshot → the roster IS the current ACTIVE set.
   *   verified epoch >  roster.epoch → membership changed in an unknown way
   *       → DEFER (established:false): stale additions may fail closed;
   *       stale revocations must never fail open. The roster refreshes at
   *       the next legitimate account-plane touch; background wake can
   *       observe that obligation, never perform it.
   *   authority state unestablishable → DEFER (the AE-2 philosophy).
   *
   * @returns {Promise<{established: boolean, activeDevices: Array<{deviceId,inboxId}>|null, reason: string}>}
   */
  async #effectiveSiblingState() {
    const roster = this.#rosterStore() ? await this.#rosterStore().snapshot() : null;
    if (!roster) {
      return { established: true, activeDevices: [], reason: "no-roster" };
    }
    const functions = this.bus.functions && this.bus.functions["account-mutation"];
    if (!functions || typeof functions.ownAuthorityState !== "function") {
      return { established: false, activeDevices: null, reason: "own-authority-source-unavailable" };
    }
    let authority;
    try {
      authority = await this._call("account-mutation", "ownAuthorityState", {});
    } catch (err) {
      return { established: false, activeDevices: null, reason: "own-authority-fetch-threw: " + (err && err.message ? err.message : String(err)) };
    }
    if (!authority || authority.established !== true) {
      return { established: false, activeDevices: null, reason: authority && authority.reason ? String(authority.reason) : "own-authority-unestablished" };
    }
    const verifiedEpoch = Number.isInteger(authority.epoch) ? authority.epoch : 0;
    if (verifiedEpoch > roster.epoch) {
      return { established: false, activeDevices: null, reason: "authority-epoch-advanced (roster " + roster.epoch + " < verified " + verifiedEpoch + "); roster refresh due" };
    }
    return { established: true, activeDevices: roster.devices, reason: "roster-current" };
  }

  /**
   * The sibling fan-out target list for THIS send/sync round, re-derived per
   * round (M4 pin: verified current revocations filter targets before every
   * round). Legacy home-fanout runtimes keep the shipped account-mode read
   * byte-identical; the roster path serves the claimant shape.
   * @returns {Promise<{targets: Array<{deviceId,inboxId}>|null, deferred: boolean, reason: string}>}
   */
  async siblingTargets() {
    if (this.bus.runtime && this.bus.runtime.multiDeviceFanout === true) {
      const sdk = this.#sdk();
      try {
        const siblings = await sdk.listSiblingDeviceInboxes();
        return { targets: Array.isArray(siblings) ? siblings : [], deferred: false, reason: "home-aggregate" };
      } catch (err) {
        return { targets: null, deferred: true, reason: "listSiblingDeviceInboxes failed: " + (err && err.message ? err.message : String(err)) };
      }
    }
    const resolved = await this.#effectiveSiblingState();
    if (!resolved.established) {
      // The frozen rule: cannot establish current membership → outbound
      // sibling sync DEFERS rather than fanning to yesterday's roster.
      this.logger.warn("[ServerAccountStateSyncService] outbound sibling sync deferred: " + resolved.reason);
      return { targets: null, deferred: true, reason: resolved.reason };
    }
    const ownDeviceId = this.#deviceId();
    const targets = resolved.activeDevices.filter((d) => d.deviceId !== ownDeviceId);
    return { targets, deferred: false, reason: resolved.reason };
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
   *
   * `targets` (P1.3-pre, frozen R1): the activation-baseline path addresses
   * the BOOTSTRAPPING device DIRECTLY from ceremony-fresh knowledge — the
   * approver's committed device.add, or the device's own signed re-request.
   * That device publishes no bundle until its READY→ACTIVE commit, so every
   * DeviceSet-derived resolution structurally cannot contain it; explicit
   * targets bypass sibling resolution and are never DeviceSet-discovered.
   * @param {{op: string, payload: object, targets?: Array<{deviceId?: string, inboxId: string}>|null}} delta
   * @returns {Promise<{fannedOut: number}>}
   */
  async replicate({ op, payload, targets = null } = {}) {
    if (!this.isEnabled()) return { fannedOut: 0 };
    const sdk = this.#sdk();
    const originDeviceId = this.#deviceId();

    const directTargets = Array.isArray(targets);
    let siblings;
    if (directTargets) {
      siblings = targets.filter((t) => t && typeof t.inboxId === "string" && t.inboxId.trim().length > 0);
      if (siblings.length === 0) return { fannedOut: 0 };
    } else {
      // M4: one target-resolution seam for every outbound round — legacy
      // home-fanout keeps the shipped account-mode read; the claimant/roster
      // path composes durable roster + verified authority state and DEFERS
      // when current membership cannot be established (never fails open).
      const resolution = await this.siblingTargets();
      if (resolution.deferred) return { fannedOut: 0, deferred: true };
      siblings = resolution.targets;
      if (!Array.isArray(siblings) || siblings.length === 0) return { fannedOut: 0 };
    }

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
        if (directTargets) {
          // A direct activation send has its OWN recovery story: the
          // BOOTSTRAPPING device's stall re-request, answered by an
          // idempotent full re-baseline. Do NOT stash it in the pending
          // queue — flushPending validates entries against the effective
          // ACTIVE sibling set, which structurally cannot contain this
          // inbox, and would drop it with a misleading revoked-device error.
          this.logger.warn("[ServerAccountStateSyncService] direct activation send to " + inboxId
            + " failed (the device's stall re-request covers): " + (err && err.message ? err.message : err));
        } else {
          // AF6b/Finding 3: a failed dispatch (e.g. sender offline) is not silently
          // lost — persist it for retry on reconnect. Re-dispatching the SAME signed
          // event is idempotent at the sibling (verified sig + highest-lamport-wins).
          this.logger.warn("[ServerAccountStateSyncService] account-state fan-out to sibling failed; queued for retry",
            err && err.message ? err.message : err);
          await this.#stashPending(inboxId, eventJson);
        }
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
    // M4: a queued retry is still a SEND — it re-verifies membership like any
    // other round. Deferred resolution keeps every entry for a later flush;
    // an entry addressed to an inbox no longer in the effective ACTIVE set is
    // DROPPED loudly (that is precisely the send-to-known-revoked case the
    // frozen rule forbids).
    const resolution = await this.siblingTargets();
    if (resolution.deferred) return { flushed: 0, dropped: 0, deferred: true };
    const allowedInboxes = new Set(resolution.targets.map((t) => t.inboxId));
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
      if (!allowedInboxes.has(rec.inboxId)) {
        await this.#kv.delete(key);
        dropped += 1;
        this.logger.error("[ServerAccountStateSyncService] dropping queued account-state send: inbox "
          + rec.inboxId + " is no longer in the account's effective ACTIVE device set (M4 rule: never knowingly target a removed device)");
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
   * FU4 (anti-entropy): re-replicate ALL active contacts (rich contact.upsert) to
   * siblings so a sibling that missed deltas entirely — offline past the durable
   * home's retention, or freshly recovered — converges. Idempotent at the sibling
   * (higher lamport re-applies the same state). Throttled (RECONCILE_MIN_INTERVAL_MS)
   * since it re-signs + re-fans every active contact. @returns {Promise<{reconciled}>}
   */
  async reconcileToSiblings() {
    if (!this.isEnabled()) return { reconciled: 0 };
    const now = this.#clock();
    if (this.#kv) {
      const at = await this.#kv.get(RECONCILE_AT_KEY);
      // Throttle ONLY when a prior reconcile ran recently — a first-ever reconcile
      // (no record) always runs.
      if (at && Number.isInteger(at.atMs) && now - at.atMs < RECONCILE_MIN_INTERVAL_MS) {
        return { reconciled: 0, throttled: true };
      }
    }
    const reconciled = await this.#replicateAllActiveContacts();
    if (this.#kv) await this.#kv.set(RECONCILE_AT_KEY, { atMs: now });
    return { reconciled };
  }

  /** The full-state contact loop shared by the throttled reconcile and the
   *  activation baseline (which must never be throttled). `targets` threads
   *  the baseline's DIRECT addressing (frozen R1) through to replicate();
   *  null keeps the sibling fan-out for the reconcile path. */
  async #replicateAllActiveContacts(targets = null) {
    const services = this.bus.services || {};
    const contacts = services.contacts || null;
    const threads = services.threads || null;
    const peerLinks = this.#peerLinks();
    if (!contacts || typeof contacts.listContacts !== "function" || !peerLinks) return 0;
    let list;
    try {
      list = await contacts.listContacts({});
    } catch (err) {
      this.logger.warn("[ServerAccountStateSyncService] reconcile: listContacts failed", err && err.message ? err.message : err);
      return 0;
    }
    const items = list && Array.isArray(list.items) ? list.items : (list && Array.isArray(list.contacts) ? list.contacts : []);
    const store = peerLinks.peerLinkStorage && peerLinks.peerLinkStorage.peerLinks ? peerLinks.peerLinkStorage.peerLinks : null;
    let reconciled = 0;
    for (const c of items) {
      const accountId = c && typeof c.accountId === "string" ? c.accountId : "";
      const rel = c && typeof c.relationshipState === "string" ? c.relationshipState.trim().toLowerCase() : "";
      if (!accountId || rel !== "active") continue;
      const payload = { accountId, relationshipState: "active", displayName: c.displayName || "" };
      if (store) {
        let rec = null;
        try {
          rec = await store.getByPair(this.ownerAccountId, accountId);
        } catch (err) {
          this.logger.warn("[ServerAccountStateSyncService] reconcile: getByPair failed for " + accountId, err && err.message ? err.message : err);
          rec = null;
        }
        if (rec && typeof rec === "object") {
          payload.peerInboxId = typeof rec.peerInboxId === "string" ? rec.peerInboxId : "";
          payload.peerLinkId = typeof rec.peerLinkId === "string" ? rec.peerLinkId : "";
          payload.remoteAccountIdentityPublicKeyB64 = typeof rec.remoteAccountIdentityPublicKeyB64 === "string" ? rec.remoteAccountIdentityPublicKeyB64 : "";
          payload.remoteIdentityDhPublicKeyB64 = typeof rec.remoteIdentityDhPublicKeyB64 === "string" ? rec.remoteIdentityDhPublicKeyB64 : "";
          if (threads && typeof threads.directThreadIdForPeerLink === "function" && payload.peerLinkId) {
            payload.threadId = threads.directThreadIdForPeerLink(payload.peerLinkId, accountId);
          }
        }
      }
      await this.replicate({ op: "contact.upsert", payload, targets });
      reconciled += 1;
    }
    return reconciled;
  }

  /**
   * Device activation baseline (plans/DEVICE_ACTIVATION_PLAN.md): an
   * UNTHROTTLED full-state reconcile terminated by an
   * `activation.baselineComplete` marker bound to the activation transaction.
   * horizonLamport = this origin's lamport AFTER the last baseline event, so
   * the receiving device can check "everything ≤ horizon applied" before
   * READY. Idempotent by construction: replays fold to no-ops at siblings
   * (highest-lamport-wins full-row state), so a recovery RESEND needs no
   * undo-and-restart protocol.
   *
   * FROZEN (P1.3-pre R1): the baseline is a TARGETED send — it goes DIRECTLY
   * to the new device's ceremony/bootstrap inbox, named by the caller from
   * ceremony-fresh knowledge (the approver's committed device.add, or a
   * verified re-request). It never discovers its destination through
   * DeviceSet: a BOOTSTRAPPING device has no bundle by design, so a
   * DeviceSet-derived fan-out silently excludes the ONE device the baseline
   * exists for (the zero-recipient trap). A missing target is refused
   * loudly, never downgraded to sibling fan-out.
   */
  async sendActivationBaseline({ activationId, target } = {}) {
    if (!this.isEnabled()) return { sent: false, reason: "disabled" };
    const id = typeof activationId === "string" ? activationId.trim() : "";
    if (!id) return { sent: false, reason: "no-activation-id" };
    const targetInboxId = target && typeof target.inboxId === "string" ? target.inboxId.trim() : "";
    if (!targetInboxId) {
      this.logger.error("[ServerAccountStateSyncService] sendActivationBaseline refused for activation " + id
        + ": no target inbox (frozen R1: the baseline is addressed from ceremony knowledge, never DeviceSet)");
      return { sent: false, reason: "no-target-inbox" };
    }
    const targetDeviceId = target && typeof target.deviceId === "string" ? target.deviceId.trim() : "";
    const targets = [{ deviceId: targetDeviceId, inboxId: targetInboxId }];
    const reconciled = await this.#replicateAllActiveContacts(targets);
    // The horizon is this origin's lamport after the last baseline event —
    // read from the same durable counter replicate() advances.
    const lamportRec = this.#kv ? await this.#kv.get(LAMPORT_KEY_PREFIX + this.ownerAccountId) : null;
    const horizonLamport = lamportRec && Number.isInteger(lamportRec.lamport) ? lamportRec.lamport : 0;
    const marker = await this.replicate({
      op: "activation.baselineComplete",
      payload: { activationId: id, horizonLamport },
      targets,
    });
    if (!marker || !Number.isInteger(marker.fannedOut) || marker.fannedOut < 1) {
      // Zero recipients is NOT success: without the marker the device can
      // never reach READY off this round. Report it; the stall re-request
      // and idempotent resend are the recovery.
      return { sent: false, reason: "marker-undeliverable", reconciled, horizonLamport };
    }
    return { sent: true, reconciled, horizonLamport };
  }

  /**
   * The BOOTSTRAPPING device's liveness request, sent on every activation
   * sync — the first connect included (FROZEN:
   * never a completeness substitute; only a valid marker produces READY).
   * Fanned to siblings over the same channel (the REQUEST can ride the
   * DeviceSet-derived list — established siblings all have bundles); the
   * payload carries THIS device's own claimed inbox so the answering sibling
   * can target the baseline back directly (frozen R1: the answer never
   * discovers its destination through DeviceSet, where a BOOTSTRAPPING
   * requester structurally does not appear).
   */
  async requestActivationBaseline({ activationId } = {}) {
    if (!this.isEnabled()) return { sent: false, reason: "disabled" };
    const id = typeof activationId === "string" ? activationId.trim() : "";
    if (!id) return { sent: false, reason: "no-activation-id" };
    const claimant = this.bus.runtime && this.bus.runtime.inboxClaimant ? this.bus.runtime.inboxClaimant : null;
    const requestInboxId = claimant && typeof claimant.inboxId === "string" ? claimant.inboxId.trim() : "";
    if (!requestInboxId) {
      // Without an own inbox the request could still reach siblings but
      // could never be ANSWERED — requesting the impossible would look like
      // liveness while delivering nothing. Refuse loudly instead.
      this.logger.error("[ServerAccountStateSyncService] requestActivationBaseline refused for activation " + id
        + ": own inbox unavailable — the answering sibling would have no deliverable destination");
      return { sent: false, reason: "own-inbox-unavailable" };
    }
    await this.replicate({ op: "activation.baselineRequest", payload: { activationId: id, requestInboxId } });
    return { sent: true };
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

    const applied = await this.#applyOp(event, { seenBeforeLamport: seen });

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
  async #applyOp(event, { seenBeforeLamport = 0 } = {}) {
    const p = event.payload && typeof event.payload === "object" ? event.payload : {};
    const services = this.bus.services || {};
    const contacts = services.contacts || null;
    const threads = services.threads || null;
    const now = this.#clock();

    if (event.op === "activation.baselineComplete") {
      // Route to the activation service when THIS device is the one
      // bootstrapping; every other sibling treats the marker as an applied
      // no-op. `seenBeforeLamport` is the completeness check: every baseline
      // event from this origin at ≤ horizon must already be folded.
      const functions = this.bus.functions && this.bus.functions["device-activation"];
      if (functions && typeof functions.baselineComplete === "function") {
        try {
          await this._call("device-activation", "baselineComplete", {
            activationId: typeof p.activationId === "string" ? p.activationId : "",
            originDeviceId: event.originDeviceId,
            horizonLamport: Number.isInteger(p.horizonLamport) ? p.horizonLamport : NaN,
            seenBeforeLamport,
          });
        } catch (err) {
          this.logger.error("[ServerAccountStateSyncService] activation marker handling failed (stall recovery will re-request)",
            err && err.message ? err.message : err);
        }
      }
      return true;
    }

    if (event.op === "activation.baselineRequest") {
      // A BOOTSTRAPPING sibling asked for the baseline. Answer only when THIS
      // device is itself established (it is: a bootstrapping device never
      // reaches applyInbound for its own request — self-origin is dropped).
      // Throttled per activationId so a request storm cannot loop.
      //
      // FROZEN (P1.3-pre R1): the answer is targeted DIRECTLY at the inbox
      // the request names — origin-device-signed alongside the rest of the
      // payload, the same self-attested-inbox trust shape as a device's own
      // published bundle — never DeviceSet-derived (the requester is
      // structurally absent there until its activation commits).
      const id = typeof p.activationId === "string" ? p.activationId.trim() : "";
      if (id && this.isEnabled()) {
        const requestInboxId = typeof p.requestInboxId === "string" ? p.requestInboxId.trim() : "";
        if (!requestInboxId) {
          this.logger.warn("[ServerAccountStateSyncService] baselineRequest for activation " + id
            + " names no requester inbox (pre-fix requester?); the baseline cannot be targeted — not answered");
          return true;
        }
        // M4 posture on the direct path: explicit targeting bypasses the
        // DeviceSet-derived sibling filter, so re-verify the activation cert
        // against CURRENT verified authority before answering. Never
        // knowingly serve a baseline for a revoked enrollment; an
        // unestablishable authority state DEFERS (fail closed) — the
        // requester's stall loop re-asks.
        let authority = null;
        try {
          authority = await this._call("account-mutation", "ownAuthorityState", {});
        } catch (err) {
          this.logger.warn("[ServerAccountStateSyncService] baselineRequest for activation " + id
            + " deferred: own authority state unavailable: " + (err && err.message ? err.message : err));
          return true;
        }
        if (!authority || authority.established !== true) {
          this.logger.warn("[ServerAccountStateSyncService] baselineRequest for activation " + id
            + " deferred: own authority state unestablished"
            + (authority && authority.reason ? " (" + authority.reason + ")" : ""));
          return true;
        }
        const revokedCertIds = authority.revocationState && Array.isArray(authority.revocationState.revokedCertIds)
          ? authority.revocationState.revokedCertIds
          : [];
        if (revokedCertIds.includes(id)) {
          this.logger.error("[ServerAccountStateSyncService] refusing baselineRequest: activation cert " + id
            + " is REVOKED (M4: never knowingly serve a removed device)");
          return true;
        }
        const throttleKey = "app:account-state/baseline-sent/" + id;
        const last = this.#kv ? await this.#kv.get(throttleKey) : null;
        const now = this.#clock();
        if (!last || !Number.isInteger(last.atMs) || now - last.atMs > 30_000) {
          if (this.#kv) await this.#kv.set(throttleKey, { atMs: now });
          try {
            await this.sendActivationBaseline({
              activationId: id,
              target: { deviceId: event.originDeviceId, inboxId: requestInboxId },
            });
          } catch (err) {
            this.logger.error("[ServerAccountStateSyncService] baseline resend failed",
              err && err.message ? err.message : err);
          }
        }
      }
      return true;
    }

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
