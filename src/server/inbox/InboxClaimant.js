import { base64ToBytes, CapabilitySigner, InboxClaimStore } from "@rezprotocol/sdk/client";
import { readPortablePrimaryInboxId } from "./PortableInboxEstablisher.js";

const PRIMARY_INBOX_KEY = "chat-server:inbox:primary:v1";

/**
 * Chat-server's persistent inbox claim.
 *
 * Bootstrapped on first boot using chat-server's OWN encrypted storage — the
 * claimant private key never lives in SDK runtime memory or node-side storage.
 * Subsequent boots load the same claim record from storage and reattest to the
 * node on reconnect.
 *
 * Exposes:
 *   - inboxId / claimantPublicKeyB64 / rootCap — public-facing identifiers
 *   - claimStore — for SDK wire ops (inbox.claim / reattest)
 *   - createCapabilitySigner() — for delegating sub-caps to peers
 *
 * The claimant private key is held internally and surfaced only via signing
 * operations. Callers receive a CapabilitySigner that can delegate sub-caps
 * rooted in this inbox's rootCap; they never get raw bytes.
 */
export class InboxClaimant {
  #claimStore;
  #claim;
  #cryptoProvider;
  #kvStore;

  static async bootstrap({ storageProvider, cryptoProvider, identity = null, delegatedInboxId = null, role = "legacy", claimStore = null } = {}) {
    if (!storageProvider || typeof storageProvider.getKeyValueStore !== "function") {
      throw new Error("InboxClaimant.bootstrap requires storageProvider");
    }
    if (!cryptoProvider) {
      throw new Error("InboxClaimant.bootstrap requires cryptoProvider");
    }
    if (role !== "legacy" && role !== "enrollment" && role !== "portable") {
      throw new Error("InboxClaimant.bootstrap role must be \"legacy\", \"enrollment\" or \"portable\"");
    }
    // P1.3b: InboxClaimStore caches the WHOLE claims array in memory and
    // persists it whole — two instances over one storage are last-writer-wins
    // and silently drop each other's writes (the portable establishment once
    // clobbered the bootstrap claim's recorded lease exactly this way). A
    // caller that already owns a store for this storage domain (the
    // enrollment wiring shares the establisher's) MUST inject it; hydrate()
    // is idempotent.
    if (claimStore === null) {
      claimStore = new InboxClaimStore({ storageProvider, cryptoProvider });
    }
    await claimStore.hydrate();
    const kvStore = storageProvider.getKeyValueStore(null);

    // P1.3b (the frozen R3 phase invariants) — the split-transport roles:
    //
    //   "enrollment": the BOUNDED activation session. Claims EXACTLY the
    //     delegated envelope's bootstrap inbox and never records it as any
    //     primary — the bootstrap address is the enrollment route, not the
    //     device's lifetime identity. After ACTIVE it goes dormant: nothing
    //     re-claims, renews, or publishes it (R2).
    //   "portable": the STEADY-STATE boot. The runtime inbox comes from the
    //     claim store's portable primary ONLY. No portable primary means the
    //     enrollment/activation transaction did not finish — resume it. The
    //     bootstrap inbox is NEVER a fallback, by ruling.
    //   "legacy" (default): the shipped single-transport behavior, byte-
    //     identical — desktop/browser topologies where the ceremony inbox IS
    //     the runtime primary, and fresh-mint primaries.
    if (role === "enrollment") {
      const ceremony = typeof delegatedInboxId === "string" && delegatedInboxId.trim().length > 0
        ? delegatedInboxId.trim()
        : null;
      if (!ceremony) {
        throw new Error("InboxClaimant.bootstrap enrollment role requires the delegated envelope's bootstrap inboxId");
      }
      let claim = claimStore.get(ceremony);
      if (!claim) {
        const fresh = await claimStore.createClaim({ inboxId: ceremony });
        claim = await claimStore.persist(fresh);
        if (identity && typeof identity.publicKeyB64 === "string"
          && identity.publicKeyB64 === claim.claimantPublicKeyB64) {
          throw new Error("InboxClaimant.bootstrap: fresh claimant key equals the account identity key — role conflation reintroduced");
        }
      }
      return new InboxClaimant({ claimStore, claim, cryptoProvider, kvStore });
    }
    if (role === "portable") {
      const pointer = await readPortablePrimaryInboxId(storageProvider);
      if (!pointer) {
        // The halfway state (delegated envelope exists, no portable primary)
        // means "enrollment/activation incomplete — resume it", NEVER "use
        // the bootstrap inbox for now" (frozen R3 no-fallback rule).
        const err = new Error("InboxClaimant.bootstrap: no portable primary inbox is established — "
          + "enrollment/activation is incomplete; resume the activation flow. "
          + "The bootstrap inbox is NOT a fallback.");
        err.code = "ENROLLMENT_INCOMPLETE";
        throw err;
      }
      const claim = claimStore.get(pointer);
      if (!claim) {
        throw new Error("InboxClaimant.bootstrap: the portable primary pointer names " + pointer
          + " but the claim store holds no claim for it — storage inconsistency");
      }
      const ceremony = typeof delegatedInboxId === "string" && delegatedInboxId.trim().length > 0
        ? delegatedInboxId.trim()
        : null;
      if (ceremony && ceremony === claim.inboxId) {
        throw new Error("InboxClaimant.bootstrap: the portable primary equals the bootstrap inbox ("
          + ceremony + ") — the split-transport invariant forbids this");
      }
      return new InboxClaimant({ claimStore, claim, cryptoProvider, kvStore });
    }

    const storedRaw = await kvStore.get(PRIMARY_INBOX_KEY);
    const stored = typeof storedRaw === "string" && storedRaw.trim().length > 0 ? storedRaw.trim() : null;
    // P1#2 L3.5: a delegated device linked via the device-link ceremony must claim the EXACT
    // inbox the ceremony pre-registered (device.add) — the one persisted in its keystore —
    // never a freshly-minted one (else device.add(A)+device.bind(B) → ACCOUNT_DEVICE_CONFLICT).
    const ceremony = typeof delegatedInboxId === "string" && delegatedInboxId.trim().length > 0
      ? delegatedInboxId.trim()
      : null;
    // A restart keeps the already-persisted inbox; a keystore naming a DIFFERENT inbox than the
    // one already claimed is a hard inconsistency (two identities for one device) — fail loud.
    if (stored && ceremony && stored !== ceremony) {
      throw new Error(
        "InboxClaimant.bootstrap: persisted primary inbox (" + stored
          + ") does not match the delegated keystore's ceremony inbox (" + ceremony + ")",
      );
    }
    // stored wins on restart; the ceremony inbox seeds a fresh delegated boot; null = the
    // legacy fresh-claim path (primary account or a delegated keystore without an inbox).
    const target = stored || ceremony;
    let claim = target ? claimStore.get(target) : null;
    if (!claim) {
      // F8 (plans/F8_REZCHAT_ROLE_SPLIT_PLAN.md): every NEW claim mints a
      // FRESH RANDOM claimant keypair — the claimant key is never the
      // account/session identity again. The old rationale ("one keypair
      // authenticates the WS session and owns the inbox, so routing stays
      // symmetric") was exactly the role conflation F8 removes: the node's
      // session registry already routes by claimant key independently of the
      // session identity (CAPABILITY_MODEL §8), so nothing needs the
      // symmetry. `inboxId: target` still claims the exact ceremony inbox
      // when set; null mints a fresh one.
      const fresh = await claimStore.createClaim({ inboxId: target });
      claim = await claimStore.persist(fresh);
      await kvStore.set(PRIMARY_INBOX_KEY, claim.inboxId);
      // The distinctness is asserted, not conventional: a fresh claim whose
      // key collides with the account identity is a broken RNG or a
      // reintroduced identity pass-through — fail loud either way.
      if (identity && typeof identity.publicKeyB64 === "string"
        && identity.publicKeyB64 === claim.claimantPublicKeyB64) {
        throw new Error("InboxClaimant.bootstrap: fresh claimant key equals the account identity key — role conflation reintroduced");
      }
    }
    // EXISTING claims are kept as-is (F9 ruling / migration decision 1): a
    // legacy claim keyed by the historical session identity continues as a
    // CLAIMANT-ONLY credential — same bytes, no longer presented as session
    // identity. Rotation is the user's explicit choice via recovery/reinvite.

    return new InboxClaimant({ claimStore, claim, cryptoProvider, kvStore });
  }

  constructor({ claimStore, claim, cryptoProvider, kvStore } = {}) {
    this.#claimStore = claimStore;
    this.#claim = claim;
    this.#cryptoProvider = cryptoProvider;
    this.#kvStore = kvStore;
  }

  get inboxId() {
    return this.#claim.inboxId;
  }

  get claimantPublicKeyB64() {
    return this.#claim.claimantPublicKeyB64;
  }

  get rootCap() {
    return this.#claim.rootCap;
  }

  get claimStore() {
    return this.#claimStore;
  }

  /**
   * The claimant SESSION credential (F8): the keypair a claimant-mode
   * connection authenticates with. This is the one sanctioned egress of the
   * claimant private key besides signing — the session signer and the claim
   * live in the same custody domain, and authenticating AS the claimant is
   * the entire point of the privacy-preserving path. Never hand this to
   * anything account-shaped.
   */
  sessionClaimantIdentity() {
    return {
      claimantPublicKeyB64: this.#claim.claimantPublicKeyB64,
      privateKeyB64: this.#claim.claimantPrivateKeyB64,
    };
  }

  /**
   * Returns a signer that can delegate sub-caps rooted in this inbox's rootCap.
   * The signer holds the claimant private key internally; callers pass it
   * cleartext bytes and receive signed RCapability records. Raw keys do not
   * leave this wrapper.
   */
  createCapabilitySigner() {
    const capSigner = new CapabilitySigner({ crypto: this.#cryptoProvider });
    const privateKeyBytes = base64ToBytes(this.#claim.claimantPrivateKeyB64);
    const inboxId = this.#claim.inboxId;
    const claimantPublicKeyB64 = this.#claim.claimantPublicKeyB64;
    const rootCap = this.#claim.rootCap;

    return {
      get inboxId() { return inboxId; },
      get rootCap() { return rootCap; },
      get claimantPublicKeyB64() { return claimantPublicKeyB64; },

      async signPostBearerCap({ actions = ["post"], constraints = {} } = {}) {
        return capSigner.delegateCapability({
          parentCapability: rootCap,
          actions,
          constraints,
          signerPublicKeyB64: claimantPublicKeyB64,
          granteePublicKeyB64: null,
          privateKeyBytes,
        });
      },

      async signAddressedCap({ granteePublicKeyB64, actions = ["post"], constraints = {} } = {}) {
        if (typeof granteePublicKeyB64 !== "string" || granteePublicKeyB64.trim().length === 0) {
          throw new Error("signAddressedCap requires granteePublicKeyB64");
        }
        return capSigner.delegateCapability({
          parentCapability: rootCap,
          actions,
          constraints,
          signerPublicKeyB64: claimantPublicKeyB64,
          granteePublicKeyB64,
          privateKeyBytes,
        });
      },
    };
  }
}
