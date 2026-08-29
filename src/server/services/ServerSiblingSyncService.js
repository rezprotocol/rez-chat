import { bytesToBase64 } from "@rezprotocol/sdk/client";
import { BaseServerService } from "../base/BaseServerService.js";
import {
  SiblingSyncPayloadV1,
  TRANSFER_MAX_FACTS,
  INVENTORY_MAX_ITEMS,
} from "../../records/payloads/SiblingSyncPayloadV1.js";
import {
  isOriginalMessageKind,
  originalMessageAuthPresence,
  verifyOriginalMessageForAdmission,
  fingerprintSetDigest,
} from "../../records/payloads/originalMessageShapes.js";

/**
 * ServerSiblingSyncService (AE-2, plans/ORIGINAL_MESSAGE_ANTIENTROPY_PLAN.md
 * §3/§4): the boring, deterministic convergence loop over the immutable
 * per-thread OriginalMessage fact log. Two already-ACTIVE siblings prove
 * whether they hold the same authenticated fact set for a thread and
 * transfer only the missing immutable records until they converge:
 *
 *     digest → (mismatch) inventory → set difference → transfer →
 *     verifyForAdmission → append idempotently → fold projection → repeat
 *
 * Frozen rules this service embodies:
 *   - The sibling is TRANSPORT, never authority: every transferred fact is
 *     a NEW ADMISSION — recomputed fingerprint, verified signature, chain
 *     anchoring, and CURRENT receiver-side revocation state.
 *   - Sibling admission NEVER defaults to permissive when the revocation
 *     source is unavailable (AE-1 close ruling): a fact whose sender's
 *     authority state cannot be established is DEFERRED, not admitted —
 *     the digest keeps mismatching and a later round retries.
 *   - The authoritative reconciliation set is FINGERPRINTS, never
 *     messageIds (inventory messageIds are diagnostics only).
 *   - Unsigned payloads are never sync-eligible (plan §6): the live sealed
 *     session is their only admission path.
 *
 * Stateless between rounds by design: no durable sync state, no timers.
 * Triggers: activation commit (the new sibling's first convergence),
 * (re)connect, and the on-demand directives. Round counters (in-memory,
 * windowed) bound pathological exchange loops; a permanently-rejected fact
 * is remembered for the process lifetime so it is not re-requested forever.
 */
const SYNC_ALL_MIN_INTERVAL_MS = 60 * 1000;
const MAX_ROUNDS_PER_PEER_THREAD = 6;
const ROUND_WINDOW_MS = 10 * 60 * 1000;

export class ServerSiblingSyncService extends BaseServerService {
  #clock;
  // fingerprints that FAILED admission verification (not deferrals) — never
  // re-request/re-admit them this process; each was logged when rejected.
  #rejectedFingerprints = new Set();
  // (originDeviceId + "|" + threadId) → { count, windowStartMs } — bounds
  // exchange rounds per peer thread per window.
  #roundCounts = new Map();
  #lastSyncAllMs = 0;

  constructor({ bus, ownerAccountId, clock = () => Date.now(), logger = console } = {}) {
    super({ bus, ownerAccountId, logger });
    this.#clock = typeof clock === "function" ? clock : () => Date.now();
    this._register("sibling-sync", "syncAll", (payload) => this.syncAll(payload || {}));
    this._register("sibling-sync", "syncThread", (payload) => this.syncThread(payload || {}));
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

  #threadStore() {
    return this.bus.stores && this.bus.stores.threadStore ? this.bus.stores.threadStore : null;
  }

  // Same enablement as the S14 channel this rides on — the account-state
  // sync service is the SSOT for "siblings exist and the sealed channel
  // works"; single-device/fs/legacy runtimes no-op byte-identically.
  isEnabled() {
    const sync = this.bus.services && this.bus.services.accountStateSync ? this.bus.services.accountStateSync : null;
    return Boolean(
      sync && typeof sync.isEnabled === "function" && sync.isEnabled()
        && this.#threadStore()
        && this.bus.services && this.bus.services.events
        && typeof this.bus.services.events.applyUserMessage === "function",
    );
  }

  /**
   * Announce a digest for every known thread to every sibling. Throttled
   * (the reconnect trigger can fire in bursts); `force` bypasses for the
   * activation trigger and tests. Empty threads announce too — a freshly
   * activated device's logs are empty and its digests are what pull history.
   */
  async syncAll({ force = false } = {}) {
    if (!this.isEnabled()) return { announced: 0, reason: "disabled" };
    const now = this.#clock();
    if (force !== true && now - this.#lastSyncAllMs < SYNC_ALL_MIN_INTERVAL_MS) {
      return { announced: 0, throttled: true };
    }
    this.#lastSyncAllMs = now;
    const threadIds = await this.#threadStore().listThreadIds();
    let announced = 0;
    for (const threadId of threadIds) {
      try {
        await this.#sendDigest({ threadId });
        announced += 1;
      } catch (err) {
        this.logger.warn("[ServerSiblingSyncService] digest announce failed for " + threadId,
          err && err.message ? err.message : err);
      }
    }
    return { announced };
  }

  async syncThread({ threadId } = {}) {
    if (!this.isEnabled()) return { announced: 0, reason: "disabled" };
    const id = typeof threadId === "string" ? threadId.trim() : "";
    if (!id) throw new Error("ServerSiblingSyncService.syncThread requires threadId");
    await this.#sendDigest({ threadId: id });
    return { announced: 1 };
  }

  /**
   * Inbound sealed sibling-sync payload (kind-registry dispatch; it arrived
   * over the account-state AEAD, so SOME account device authored it). The
   * origin-device signature proves WHICH one before anything else is
   * trusted. Fail-closed on verification.
   */
  async handleInbound(record) {
    if (!(record instanceof SiblingSyncPayloadV1)) return { handled: false, reason: "not-a-sync-record" };
    if (!this.isEnabled()) return { handled: false, reason: "disabled" };
    const peerLinks = this.#peerLinks();
    if (!peerLinks || typeof peerLinks.verifyAccountStateEventSig !== "function") {
      this.logger.error("[ServerSiblingSyncService] cannot verify sync origin signature (no verifier); dropping");
      return { handled: false, reason: "unverifiable" };
    }
    const signable = SiblingSyncPayloadV1.signableBytes(record);
    const sigOk = await peerLinks.verifyAccountStateEventSig({
      signableBytes: signable,
      originDeviceId: record.originDeviceId,
      originDevicePublicKeyB64: record.originDevicePublicKeyB64,
      sigB64: record.sig,
    });
    if (!sigOk) {
      this.logger.warn("[ServerSiblingSyncService] sync payload failed origin-device signature; dropping");
      return { handled: false, reason: "bad-signature" };
    }
    if (record.originDeviceId === this.#deviceId()) {
      return { handled: false, reason: "self-origin" };
    }
    if (record.op === "digest") return this.#handleDigest(record);
    if (record.op === "inventory") return this.#handleInventory(record);
    if (record.op === "transfer") return this.#handleTransfer(record);
    if (record.op === "transferAck") {
      if (record.deferredFingerprints.length > 0) {
        this.logger.warn("[ServerSiblingSyncService] sibling deferred " + record.deferredFingerprints.length
          + " transferred fact(s) for " + record.threadId + " (revocation source unavailable there; later rounds retry)");
      }
      return { handled: true, op: "transferAck" };
    }
    return { handled: false, reason: "unknown-op" };
  }

  async #handleDigest(record) {
    const local = await this.#threadStore().listOriginalFingerprints({ threadId: record.threadId });
    if (fingerprintSetDigest(local) === record.setDigest) {
      return { handled: true, op: "digest", converged: true };
    }
    if (!this.#allowRound(record.originDeviceId, record.threadId)) {
      return { handled: true, op: "digest", suppressed: true };
    }
    await this.#sendInventory({
      threadId: record.threadId,
      fingerprints: local,
      replyToDigest: true,
      toDeviceId: record.originDeviceId,
    });
    return { handled: true, op: "digest", converged: false };
  }

  async #handleInventory(record) {
    const threadStore = this.#threadStore();
    const remote = new Set();
    for (const item of record.items) {
      if (item && typeof item.fingerprint === "string" && item.fingerprint.length > 0) {
        remote.add(item.fingerprint);
      }
    }
    const local = await threadStore.listOriginalFingerprints({ threadId: record.threadId });
    const localSet = new Set(local);

    // Facts the SIBLING lacks — transfer them, batched.
    const toSend = local.filter((fp) => !remote.has(fp));
    let transferred = 0;
    for (let at = 0; at < toSend.length; at += TRANSFER_MAX_FACTS) {
      const batch = [];
      for (const fp of toSend.slice(at, at + TRANSFER_MAX_FACTS)) {
        const fact = await threadStore.getOriginalFact({ threadId: record.threadId, fingerprint: fp });
        // The log holds only admitted signed facts, but guard anyway — an
        // unsigned payload must never ride sibling transfer (plan §6).
        if (fact && fact.payload && originalMessageAuthPresence(fact.payload) === "all") {
          batch.push(fact.payload);
        }
      }
      if (batch.length === 0) continue;
      await this.#sendSigned({
        op: "transfer",
        threadId: record.threadId,
        facts: batch,
      }, { toDeviceId: record.originDeviceId });
      transferred += batch.length;
    }

    // Facts WE lack: answer a digest-leg inventory with our own (terminal —
    // replyToDigest=false never triggers another inventory), so the sibling
    // computes the difference and transfers.
    const missingHere = [...remote].filter((fp) => !localSet.has(fp) && !this.#rejectedFingerprints.has(fp));
    if (record.replyToDigest === true && missingHere.length > 0
        && this.#allowRound(record.originDeviceId, record.threadId)) {
      await this.#sendInventory({
        threadId: record.threadId,
        fingerprints: local,
        replyToDigest: false,
        toDeviceId: record.originDeviceId,
      });
    }
    return { handled: true, op: "inventory", transferred, missingHere: missingHere.length };
  }

  async #handleTransfer(record) {
    const admitted = [];
    const deferred = [];
    for (const payloadJson of record.facts) {
      const outcome = await this.#admitFact(payloadJson);
      if (outcome.status === "admitted") admitted.push(outcome.fingerprint);
      else if (outcome.status === "deferred") deferred.push(outcome.fingerprint);
      // rejected facts are logged in #admitFact and remembered; they are
      // deliberately NOT acked as deferred (nothing should retry them).
    }
    await this.#sendSigned({
      op: "transferAck",
      threadId: record.threadId,
      admittedFingerprints: admitted,
      deferredFingerprints: deferred,
    }, { toDeviceId: record.originDeviceId });
    // Convergence check round: after admitting anything, re-announce our
    // digest to the origin so a remaining difference surfaces (bounded by
    // the round counter; equal digests end in silence).
    if (admitted.length > 0 && this.#allowRound(record.originDeviceId, record.threadId)) {
      await this.#sendDigest({ threadId: record.threadId, toDeviceId: record.originDeviceId });
    }
    return { handled: true, op: "transfer", admitted: admitted.length, deferred: deferred.length };
  }

  /**
   * Admit ONE sibling-transferred fact (plan §4). Outcomes:
   *   admitted — verified against CURRENT revocation state, in the log
   *              (idempotently), projection folded via the live ingest seam.
   *   deferred — the sender's authority/revocation state could not be
   *              established, or the ingest seam gated it (e.g. the thread/
   *              contact baseline has not landed yet). Not an error; later
   *              rounds retry.
   *   rejected — failed verification. Logged, remembered, never retried.
   */
  async #admitFact(payloadJson) {
    const p = payloadJson && typeof payloadJson === "object" && !Array.isArray(payloadJson) ? payloadJson : null;
    const claimedHash = p && typeof p.contentHash === "string" ? p.contentHash.trim() : "";
    if (!p || !isOriginalMessageKind(p.kind)) {
      this.logger.warn("[ServerSiblingSyncService] rejected transferred fact: not an OriginalMessage kind");
      if (claimedHash) this.#rejectedFingerprints.add(claimedHash);
      return { status: "rejected", fingerprint: claimedHash };
    }
    if (originalMessageAuthPresence(p) !== "all") {
      // Frozen (plan §6): unsigned payloads are admitted only via the live
      // sealed session — NEVER via sibling transfer.
      this.logger.warn("[ServerSiblingSyncService] rejected transferred fact: unsigned facts are never sync-eligible");
      if (claimedHash) this.#rejectedFingerprints.add(claimedHash);
      return { status: "rejected", fingerprint: claimedHash };
    }
    const threadId = typeof p.threadId === "string" ? p.threadId.trim() : "";
    const senderAccountId = typeof p.senderAccountId === "string" ? p.senderAccountId.trim() : "";
    if (!threadId || !senderAccountId) {
      this.logger.warn("[ServerSiblingSyncService] rejected transferred fact: missing threadId/senderAccountId");
      if (claimedHash) this.#rejectedFingerprints.add(claimedHash);
      return { status: "rejected", fingerprint: claimedHash };
    }

    // AE-1 close ruling: sibling admission may NOT default to permissive
    // when the revocation source is unavailable — defer instead.
    const revocation = await this.#revocationStateFor(senderAccountId);
    if (!revocation.ok) {
      this.logger.warn("[ServerSiblingSyncService] deferring transferred fact from " + senderAccountId
        + ": " + revocation.reason);
      return { status: "deferred", fingerprint: claimedHash };
    }

    const peerLinks = this.#peerLinks();
    const cryptoProvider = peerLinks && peerLinks.cryptoProvider ? peerLinks.cryptoProvider : null;
    if (!cryptoProvider) {
      // A receiver that cannot VERIFY cannot admit an authenticated fact.
      return { status: "deferred", fingerprint: claimedHash };
    }
    const admission = await verifyOriginalMessageForAdmission({
      payloadJson: p,
      cryptoProvider,
      nowMs: this.#clock(),
      revocationState: revocation.revocationState,
    });
    if (!admission.ok) {
      this.logger.warn("[ServerSiblingSyncService] rejected transferred fact from " + senderAccountId
        + ": " + admission.reason);
      if (claimedHash) this.#rejectedFingerprints.add(claimedHash);
      return { status: "rejected", fingerprint: claimedHash };
    }

    const threadStore = this.#threadStore();
    const existing = await threadStore.getOriginalFact({ threadId, fingerprint: admission.fingerprint });
    if (existing) {
      return { status: "admitted", fingerprint: admission.fingerprint };
    }

    // Persist + fold through the SAME ingest seam live delivery uses (fact
    // append, conflict semantics, projection, mutation fold, events) — one
    // apply path, no parallel persistence. The seam re-verifies the
    // signature; the strict revocation-checked verdict above is the
    // admission decision.
    await this.bus.services.events.applyUserMessage({
      eventId: "sibsync:" + admission.fingerprint,
      mailboxId: "",
      plaintextB64: bytesToBase64(new TextEncoder().encode(JSON.stringify(p))),
      senderAccountId,
    });

    const landed = await threadStore.getOriginalFact({ threadId, fingerprint: admission.fingerprint });
    if (!landed) {
      // The seam gated it (thread/contact baseline not applied yet, or a
      // persist fault). Deferred: the digest keeps mismatching and a later
      // round retries once the baseline lands.
      this.logger.warn("[ServerSiblingSyncService] transferred fact verified but not persisted (ingest gate); deferring "
        + admission.fingerprint);
      return { status: "deferred", fingerprint: admission.fingerprint };
    }
    return { status: "admitted", fingerprint: admission.fingerprint };
  }

  /**
   * The canonical receiver-side authority/revocation source (AE-2
   * prerequisite): our OWN account state for self-authored facts
   * (sdk.devices.getAuthorityState), the peer's published
   * AccountAuthorityStateV1 via account-mutation.peerRevocationState for
   * everyone else. `{ok:false}` = COULD NOT ESTABLISH (defer); `{ok:true,
   * revocationState:null}` = established, nothing revoked (a real answer).
   */
  async #revocationStateFor(senderAccountId) {
    if (senderAccountId === this.ownerAccountId) {
      const sdk = this.#sdk();
      if (!sdk || !sdk.devices || typeof sdk.devices.getAuthorityState !== "function") {
        return { ok: false, reason: "own authority state unavailable" };
      }
      try {
        const state = await sdk.devices.getAuthorityState();
        const revokedCertIds = state && Array.isArray(state.revokedCertIds) ? state.revokedCertIds : [];
        const minValidIssuedAtMs = state && Number.isFinite(Number(state.minValidIssuedAtMs))
          ? Number(state.minValidIssuedAtMs)
          : 0;
        const revocationState = revokedCertIds.length > 0 || minValidIssuedAtMs > 0
          ? { revokedCertIds: [...revokedCertIds], minValidIssuedAtMs }
          : null;
        return { ok: true, revocationState };
      } catch (err) {
        return { ok: false, reason: "own authority state fetch failed: " + (err && err.message ? err.message : "unknown") };
      }
    }
    const accountMutation = this.bus.services && this.bus.services.accountMutation ? this.bus.services.accountMutation : null;
    if (!accountMutation
        || typeof accountMutation.isEnabled !== "function"
        || typeof accountMutation.getPeerRevocationState !== "function"
        || !accountMutation.isEnabled()) {
      // A disabled source returns null indistinguishably from "no
      // revocations" — so its availability is checked HERE, before asking.
      return { ok: false, reason: "peer revocation source unavailable" };
    }
    try {
      const revocationState = await accountMutation.getPeerRevocationState({ peerAccountId: senderAccountId });
      return { ok: true, revocationState };
    } catch (err) {
      return { ok: false, reason: "peer revocation fetch failed: " + (err && err.message ? err.message : "unknown") };
    }
  }

  async #sendDigest({ threadId, toDeviceId = null } = {}) {
    const fingerprints = await this.#threadStore().listOriginalFingerprints({ threadId });
    await this.#sendSigned({
      op: "digest",
      threadId,
      messageCount: fingerprints.length,
      setDigest: fingerprintSetDigest(fingerprints),
    }, { toDeviceId });
  }

  async #sendInventory({ threadId, fingerprints, replyToDigest, toDeviceId } = {}) {
    let listed = fingerprints;
    if (listed.length > INVENTORY_MAX_ITEMS) {
      // Bounded, visible, deterministic — never a silent cap: the sorted
      // window converges oldest-listed first; the remainder surfaces on the
      // next digest round after this window converges.
      this.logger.error("[ServerSiblingSyncService] thread " + threadId + " fact set (" + listed.length
        + ") exceeds the v1 inventory bound (" + INVENTORY_MAX_ITEMS + "); inventorying the first sorted window");
      listed = [...listed].sort().slice(0, INVENTORY_MAX_ITEMS);
    }
    const items = [];
    for (const fp of listed) {
      const fact = await this.#threadStore().getOriginalFact({ threadId, fingerprint: fp });
      items.push({
        // messageId is DIAGNOSTIC only — set math is over fingerprints.
        messageId: fact && typeof fact.messageId === "string" ? fact.messageId : null,
        fingerprint: fp,
      });
    }
    await this.#sendSigned({ op: "inventory", threadId, items, replyToDigest: replyToDigest === true }, { toDeviceId });
  }

  async #sendSigned(fields, { toDeviceId = null } = {}) {
    const peerLinks = this.#peerLinks();
    const originDeviceId = this.#deviceId();
    const originDevicePublicKeyB64 = peerLinks && typeof peerLinks.devicePublicKeyB64 === "string"
      ? peerLinks.devicePublicKeyB64
      : "";
    if (!originDeviceId || !originDevicePublicKeyB64 || typeof peerLinks.signAccountStateEvent !== "function") {
      throw new Error("ServerSiblingSyncService: no device key to sign the sync payload");
    }
    const body = {
      ...fields,
      originDeviceId,
      originDevicePublicKeyB64,
      issuedAtMs: this.#clock(),
    };
    const signed = await peerLinks.signAccountStateEvent(SiblingSyncPayloadV1.signableBytes(body));
    const record = new SiblingSyncPayloadV1({ ...body, sig: signed.sigB64 }).toJSON();
    const plaintextBodyBytes = new TextEncoder().encode(JSON.stringify(record));

    const sdk = this.#sdk();
    // M4: targets come from the accountStateSync resolution seam — one SSOT
    // for "who are my current ACTIVE siblings", including the frozen
    // defer-when-unestablished rule. Sync is round-based, so a deferred
    // round is simply covered by a later one.
    const accountState = this.bus.services ? this.bus.services.accountStateSync : null;
    if (!accountState || typeof accountState.siblingTargets !== "function") {
      this.logger.warn("[ServerSiblingSyncService] sibling target resolution unavailable; sync send skipped");
      return { sent: 0 };
    }
    const resolution = await accountState.siblingTargets();
    if (resolution.deferred) {
      this.logger.warn("[ServerSiblingSyncService] sync send deferred: " + resolution.reason);
      return { sent: 0, deferred: true };
    }
    const siblings = resolution.targets;
    if (!Array.isArray(siblings)) return { sent: 0 };
    let sent = 0;
    for (const sibling of siblings) {
      const inboxId = sibling && typeof sibling.inboxId === "string" ? sibling.inboxId : "";
      const deviceId = sibling && typeof sibling.deviceId === "string" ? sibling.deviceId : "";
      if (!inboxId) continue;
      if (toDeviceId && deviceId !== toDeviceId) continue;
      try {
        const deposit = await sdk.buildAccountStateDeposit({ deliverInboxId: inboxId, plaintextBodyBytes });
        await sdk.mesh.dispatch(deposit.object, deposit.address);
        sent += 1;
      } catch (err) {
        // Sync is retryable by construction (the next digest round covers a
        // lost message), so a failed dispatch warns rather than queues.
        this.logger.warn("[ServerSiblingSyncService] sync send to sibling failed (next round retries)",
          err && err.message ? err.message : err);
      }
    }
    return { sent };
  }

  #allowRound(originDeviceId, threadId) {
    const key = originDeviceId + "|" + threadId;
    const now = this.#clock();
    const entry = this.#roundCounts.get(key);
    if (!entry || now - entry.windowStartMs > ROUND_WINDOW_MS) {
      this.#roundCounts.set(key, { count: 1, windowStartMs: now });
      return true;
    }
    if (entry.count >= MAX_ROUNDS_PER_PEER_THREAD) {
      this.logger.warn("[ServerSiblingSyncService] round bound reached for " + key
        + " (" + MAX_ROUNDS_PER_PEER_THREAD + "/" + (ROUND_WINDOW_MS / 60000) + "min); backing off");
      return false;
    }
    entry.count += 1;
    return true;
  }
}
