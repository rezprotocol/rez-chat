import { mapUnlockedAccountToRuntimeIdentity } from "../server/bootstrap/unlockedAccountIdentity.js";
import { readPortablePrimaryInboxId } from "../server/inbox/PortableInboxEstablisher.js";

/**
 * prepareDelegatedCoreBoot — the UNLOCK → STEADY-STATE-BOOT mapping
 * (P1.3c, plans/MOBILE_PLATFORM_INTEGRATION_PLAN.md).
 *
 * The one question this module answers: given a successfully unlocked
 * DELEGATED envelope and the host's provider set, what are the exact inputs
 * `startRezChatCore()` boots from? It INTERPRETS durable enrollment truth;
 * it never establishes or repairs it — establishing the portable primary is
 * `activateDelegatedDevice`'s job (P1.3b), and a mapper that quietly
 * finished activation behind the caller's back would blur the one phase
 * boundary that keeps the transaction auditable.
 *
 *     unlock envelope (host custody)
 *         ↓ this mapping (pure projection + fail-loud interpretation)
 *     startRezChatCore(inputs) → CLAIMANT against the portable provider
 *         runtime inbox == the claim store's portable primary
 *         bootstrapInboxId rides as enrollment metadata ONLY
 *
 * The identity/deviceKey projection is the SSOT shared with the browser
 * path (`mapUnlockedAccountToRuntimeIdentity` — extracted, not copied); the
 * portable-primary read is the SSOT shared with the establisher and the
 * boot-time "portable" role (`readPortablePrimaryInboxId`).
 *
 * Fail-loud cases (frozen at the P1.3b/c rulings):
 *   - the account carries admin/root authority → REJECTED. The mobile
 *     delegated boot must be structurally unable to receive B-sign
 *     material; a primary account boots through its own path.
 *   - no bootstrapInboxId → not a mobile enrollment envelope (every
 *     ceremony-enrolled envelope carries it — a LEGACY envelope's generic
 *     `inboxId` already deserializes AS bootstrapInboxId at unlock).
 *   - no portable primary in the claim store → ENROLLMENT_INCOMPLETE:
 *     resume activation. **Never** boot claimant against the bootstrap
 *     inbox — that is the exact fallback the architecture rejected, and a
 *     store holding only the bootstrap claim is still this case.
 *   - portable primary == bootstrapInboxId → invariant violation.
 *
 * The returned object is EXACTLY the startRezChatCore input set — the boot
 * itself re-enforces the portable-role invariants at the point of use (the
 * mapper's checks are the early, typed surface; the role is the mechanism).
 *
 * @param {object} opts
 * @param {object} opts.unlocked — the unlockKeystoreAccount result
 *   (delegated: hasAdminRoot false, identityKeyPair null).
 * @param {object} opts.storageProvider — the SAME host storage enrollment/
 *   activation used (the claim store and portable pointer live in it).
 * @param {object} opts.cryptoProvider — platform RCryptoProvider.
 * @param {string[]} opts.uplinks — the PORTABLE provider wsUrls.
 * @param {(url: string) => object} opts.wsFactory — the platform WebSocket.
 * @param {string} [opts.expectedNodePublicKeyB64] — provider identity pin.
 * @param {string} [opts.retentionClass="standard"] — the phone's portable
 *   inbox runs the durable lease lifecycle by default.
 * @param {function} [opts.clock]
 * @param {object} [opts.logger]
 * @returns {Promise<object>} the startRezChatCore options, verbatim.
 */
export async function prepareDelegatedCoreBoot({
  unlocked,
  storageProvider,
  cryptoProvider,
  uplinks,
  wsFactory,
  expectedNodePublicKeyB64 = "",
  retentionClass = "standard",
  clock = () => Date.now(),
  logger = console,
} = {}) {
  if (!unlocked || typeof unlocked !== "object") {
    throw new Error("prepareDelegatedCoreBoot requires the unlocked envelope account");
  }
  // Admin/root authority is REJECTED before any projection: hasAdminRoot,
  // or any account signing keypair riding along, disqualifies this boot —
  // the steady-state mobile runtime must be unable to hold B-sign material.
  if (unlocked.hasAdminRoot !== false) {
    throw new Error("prepareDelegatedCoreBoot: the account carries admin/root authority — the mobile delegated boot refuses it (a primary account boots through its own path)");
  }
  if (unlocked.identityKeyPair !== null && unlocked.identityKeyPair !== undefined) {
    throw new Error("prepareDelegatedCoreBoot: a delegated account must carry NO account signing keypair — refusing");
  }
  if (!Array.isArray(unlocked.certChain) || unlocked.certChain.length === 0) {
    throw new Error("prepareDelegatedCoreBoot requires the delegated account's certChain");
  }
  if (!unlocked.accountIdentityDhKeyPair || typeof unlocked.accountIdentityDhKeyPair !== "object") {
    throw new Error("prepareDelegatedCoreBoot requires the delegated account's accountIdentityDhKeyPair");
  }
  const bootstrapInboxId = typeof unlocked.bootstrapInboxId === "string" && unlocked.bootstrapInboxId.trim().length > 0
    ? unlocked.bootstrapInboxId.trim()
    : "";
  if (!bootstrapInboxId) {
    throw new Error("prepareDelegatedCoreBoot: the envelope carries no bootstrapInboxId — not a mobile enrollment envelope");
  }
  if (!storageProvider || typeof storageProvider.getKeyValueStore !== "function") {
    throw new Error("prepareDelegatedCoreBoot requires storageProvider (the same one activation used)");
  }
  if (!cryptoProvider || typeof cryptoProvider !== "object") {
    throw new Error("prepareDelegatedCoreBoot requires cryptoProvider");
  }
  if (!Array.isArray(uplinks) || uplinks.length === 0) {
    throw new Error("prepareDelegatedCoreBoot requires uplinks (the portable provider)");
  }
  if (typeof wsFactory !== "function") {
    throw new Error("prepareDelegatedCoreBoot requires wsFactory (the platform WebSocket implementation)");
  }

  // Interpret durable enrollment truth — READ ONLY, no repair, no minting.
  const portableInboxId = await readPortablePrimaryInboxId(storageProvider);
  if (!portableInboxId) {
    const err = new Error("prepareDelegatedCoreBoot: no portable primary inbox is established — "
      + "enrollment/activation is incomplete; resume activateDelegatedDevice. "
      + "The bootstrap inbox is NOT a fallback.");
    err.code = "ENROLLMENT_INCOMPLETE";
    throw err;
  }
  if (portableInboxId === bootstrapInboxId) {
    throw new Error("prepareDelegatedCoreBoot: the portable primary equals the bootstrap inbox ("
      + bootstrapInboxId + ") — the split-transport invariant forbids this");
  }

  const mapped = mapUnlockedAccountToRuntimeIdentity(unlocked);
  return {
    identity: mapped.identity,
    deviceKey: mapped.deviceKey,
    storageProvider,
    cryptoProvider,
    uplinks,
    wsFactory,
    expectedNodePublicKeyB64,
    // Explicit even where it matches the mobile default: the steady state IS
    // claimant, and the portable inbox runs the durable lease lifecycle.
    sessionMode: "claimant",
    retentionClass,
    clock,
    logger,
  };
}
