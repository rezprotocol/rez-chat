import { base64ToBytes, CapabilitySigner, InboxClaimStore } from "@rezprotocol/sdk/client";

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

  static async bootstrap({ storageProvider, cryptoProvider, identity = null, delegatedInboxId = null } = {}) {
    if (!storageProvider || typeof storageProvider.getKeyValueStore !== "function") {
      throw new Error("InboxClaimant.bootstrap requires storageProvider");
    }
    if (!cryptoProvider) {
      throw new Error("InboxClaimant.bootstrap requires cryptoProvider");
    }
    const claimStore = new InboxClaimStore({ storageProvider, cryptoProvider });
    await claimStore.hydrate();
    const kvStore = storageProvider.getKeyValueStore(null);

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
      // When an identity is supplied, the claimant keypair IS the chat-server's
      // session identity — one keypair authenticates the WS session and owns
      // the inbox, so routing/lookups stay symmetric and don't need a separate
      // account-identity → claimant-identity mapping. `inboxId: target` claims the exact
      // ceremony inbox when set; null mints a fresh one (unchanged legacy behavior).
      const fresh = await claimStore.createClaim({ identity, inboxId: target });
      claim = await claimStore.persist(fresh);
      await kvStore.set(PRIMARY_INBOX_KEY, claim.inboxId);
    }

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
