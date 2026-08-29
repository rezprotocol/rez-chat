import { createRezClient, InboxClaimStore } from "@rezprotocol/sdk/client";
import { registerInboxClaimOnSession } from "./inboxClaimWire.js";

/**
 * The durable pointer naming which claim in the InboxClaimStore is THE
 * portable per-device primary. Written exactly once, by establishment below;
 * read by InboxClaimant's "portable" role at steady-state boot. The claims
 * store owns the permanent runtime inbox (R3 ruling) — this pointer plus the
 * claim record it names live in the same chat-server custody domain.
 */
export const PORTABLE_PRIMARY_INBOX_KEY = "chat-server:inbox:portable-primary:v1";

/**
 * The ONE read of the portable-primary pointer (P1.3c: the establisher, the
 * InboxClaimant "portable" role, and the delegated boot mapper all resolve
 * it through here — never through hand-rolled kv reads that could drift).
 * Pure read: null means "no portable primary was ever established"; it
 * never mints, repairs, or falls back.
 */
export async function readPortablePrimaryInboxId(storageProvider) {
  if (!storageProvider || typeof storageProvider.getKeyValueStore !== "function") {
    throw new Error("readPortablePrimaryInboxId requires storageProvider");
  }
  const kv = storageProvider.getKeyValueStore(null);
  const raw = await kv.get(PORTABLE_PRIMARY_INBOX_KEY);
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
}

/**
 * PortableInboxEstablisher (P1.3b, plans/MOBILE_PLATFORM_INTEGRATION_PLAN.md
 * — the frozen R3/commit-ordering rulings, 2026-08-26).
 *
 * Owns ONE question: does the durable portable per-device inbox exist with an
 * accepted standard-retention lease at the portable provider? Idempotent:
 *
 *   no portable primary  → mint EXACTLY ONE claim (fresh random claimant
 *                          keypair, fresh close keypair, generation 1),
 *                          persist it, record the pointer, lease it
 *   portable primary     → reuse EXACTLY that claim; (re)lease only when no
 *                          unexpired accepted lease is recorded
 *
 * A crash at any point resumes without minting another inbox: any claim that
 * ever reached the provider is the pointer's claim. The one unreferenced-
 * claim window (crash between claim persist and pointer write) leaves an
 * orphan that no lease and no publication ever named — externally invisible
 * garbage, not a second address.
 *
 * FROZEN COMMIT ORDERING: this establishment must complete — claimant/close/
 * lease state durably persisted — BEFORE bundle publication, and publication
 * remains the one externally visible commit. The wiring makes that intrinsic:
 * ServerDeviceSetService calls ensureEstablished() inside publishOwnBundle,
 * before the wire op, so a failed establishment makes publication itself
 * impossible. **There is no bootstrap-inbox fallback** — nothing here or in
 * the publish path can substitute another address.
 *
 * The lease rides a MINIMAL claimant-mode client (the claim's own keypair is
 * the session credential — F8) opened against the PORTABLE provider and
 * closed when the round-trip ends; the wire bytes are the same SSOT helper
 * the session-bind path uses. Nothing account-shaped is constructed here.
 */
export class PortableInboxEstablisher {
  #storageProvider;
  #uplinks;
  #wsFactory;
  #expectedNodePublicKeyB64;
  #bootstrapInboxId;
  #clock;
  #clientFactory;
  #logger;
  #claimStore;
  #kv;
  #ensuring;

  constructor({
    storageProvider,
    cryptoProvider,
    uplinks,
    wsFactory,
    expectedNodePublicKeyB64 = "",
    bootstrapInboxId = null,
    clock = () => Date.now(),
    clientFactory = null,
    logger = console,
  } = {}) {
    if (!storageProvider || typeof storageProvider.getKeyValueStore !== "function") {
      throw new Error("PortableInboxEstablisher requires storageProvider");
    }
    if (!cryptoProvider) throw new Error("PortableInboxEstablisher requires cryptoProvider");
    if (!Array.isArray(uplinks) || uplinks.length === 0) {
      throw new Error("PortableInboxEstablisher requires uplinks (the PORTABLE provider wsUrls)");
    }
    if (typeof wsFactory !== "function" && typeof clientFactory !== "function") {
      throw new Error("PortableInboxEstablisher requires wsFactory (or an injected clientFactory)");
    }
    if (typeof clock !== "function") throw new Error("PortableInboxEstablisher requires clock()");
    this.#storageProvider = storageProvider;
    this.#uplinks = uplinks;
    this.#wsFactory = wsFactory;
    this.#expectedNodePublicKeyB64 = typeof expectedNodePublicKeyB64 === "string" ? expectedNodePublicKeyB64.trim() : "";
    this.#bootstrapInboxId = typeof bootstrapInboxId === "string" && bootstrapInboxId.trim().length > 0
      ? bootstrapInboxId.trim()
      : null;
    this.#clock = clock;
    this.#clientFactory = typeof clientFactory === "function" ? clientFactory : null;
    this.#logger = logger;
    this.#claimStore = new InboxClaimStore({ storageProvider, cryptoProvider });
    this.#kv = storageProvider.getKeyValueStore(null);
    this.#ensuring = null;
  }

  get claimStore() {
    return this.#claimStore;
  }

  /**
   * The durably-recorded portable primary inboxId, or null when none was ever
   * established. Pure storage read — no network, no minting. This is the
   * "resume or already-active?" probe.
   */
  async establishedInboxId() {
    await this.#claimStore.hydrate();
    return readPortablePrimaryInboxId(this.#storageProvider);
  }

  /**
   * Ensure the portable primary exists with an accepted, unexpired lease.
   * Serialized: concurrent callers share one in-flight establishment.
   * Throws when the portable provider cannot accept the lease — the caller
   * (the publication path) must fail WITH it; remaining unpublished and
   * recoverable is the ruled behavior, publishing another address never is.
   * @returns {Promise<{inboxId: string, leased: "current"|"accepted"}>}
   */
  async ensureEstablished() {
    if (this.#ensuring) return this.#ensuring;
    this.#ensuring = this.#ensure().finally(() => {
      this.#ensuring = null;
    });
    return this.#ensuring;
  }

  async #ensure() {
    await this.#claimStore.hydrate();
    let inboxId = await this.establishedInboxId();
    let claim;
    if (inboxId) {
      claim = this.#claimStore.get(inboxId);
      if (!claim) {
        // The pointer names a claim the store does not hold: the claimant key
        // is GONE. Minting a replacement would silently change the device's
        // published address out from under peers — surface, never guess.
        throw new Error("PortableInboxEstablisher: the portable primary pointer names " + inboxId
          + " but the claim store holds no claim for it — storage inconsistency, refusing to mint a replacement");
      }
    } else {
      // Mint EXACTLY ONE portable claim: fresh random claimant keypair, fresh
      // close keypair, generation 1 (all inside createClaim). Persist the
      // claim BEFORE the pointer so the pointer can never name missing keys.
      const fresh = await this.#claimStore.createClaim({ clock: this.#clock });
      claim = await this.#claimStore.persist(fresh);
      await this.#kv.set(PORTABLE_PRIMARY_INBOX_KEY, claim.inboxId);
      inboxId = claim.inboxId;
    }
    // R3 phase invariant: the portable primary MUST NOT be the bootstrap
    // inbox. Checked on every path — a pointer that somehow names the
    // bootstrap address is the exact coupling this phase exists to remove.
    if (this.#bootstrapInboxId && inboxId === this.#bootstrapInboxId) {
      throw new Error("PortableInboxEstablisher: the portable primary equals the bootstrap inbox ("
        + inboxId + ") — the split-transport invariant forbids this");
    }

    // An accepted, unexpired lease already on record satisfies the commit
    // ordering (claimant/close/lease state durably persisted) without a
    // round-trip — the crash-resume publish retry must not be hostage to the
    // portable provider's momentary reachability. Steady-state renewal is the
    // claimant runtime's job (renewLeaseIfDue), not establishment's.
    const lease = this.#claimStore.leaseState(inboxId);
    if (lease && Number.isFinite(Number(lease.expiresAtMs)) && this.#clock() < Number(lease.expiresAtMs)) {
      return { inboxId, leased: "current" };
    }

    // Lease it: a minimal claimant-mode client against the portable provider.
    const client = this.#clientFactory
      ? await this.#clientFactory({
        claimantIdentity: { claimantPublicKeyB64: claim.claimantPublicKeyB64, privateKeyB64: claim.claimantPrivateKeyB64 },
        uplinks: this.#uplinks,
        wsFactory: this.#wsFactory,
        expectedNodePublicKeyB64: this.#expectedNodePublicKeyB64,
      })
      : createRezClient({
        claimantIdentity: { claimantPublicKeyB64: claim.claimantPublicKeyB64, privateKeyB64: claim.claimantPrivateKeyB64 },
        uplinks: this.#uplinks,
        clientVersion: "rez-chat-portable-establish/1.0",
        wsFactory: this.#wsFactory,
        expectedNodePublicKeyB64: this.#expectedNodePublicKeyB64,
      });
    if (!client || typeof client.connect !== "function" || typeof client.close !== "function") {
      throw new Error("PortableInboxEstablisher: client factory returned an invalid client");
    }
    try {
      await client.connect();
      await registerInboxClaimOnSession({
        sdk: client,
        claimStore: this.#claimStore,
        inboxId,
        // The portable per-device inbox runs the durable lease/grace/reclaim
        // lifecycle — the standard class, per the frozen split-transport
        // design (the phone's mailbox is exactly what Portable Home built).
        retentionClass: "standard",
        clock: this.#clock,
        logger: this.#logger,
      });
    } finally {
      try {
        await client.close();
      } catch (err) {
        this.#logger.warn("PortableInboxEstablisher: establishment client close failed",
          err && err.message ? err.message : err);
      }
    }
    return { inboxId, leased: "accepted" };
  }
}
