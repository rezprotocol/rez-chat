/**
 * mapUnlockedAccountToRuntimeIdentity — the ONE mapping from an
 * `unlockKeystoreAccount` result to the `{identity, deviceKey}` inputs the
 * chat runtime boots from (P1.3c, plans/MOBILE_PLATFORM_INTEGRATION_PLAN.md;
 * extracted from bootstrapBrowserChatRuntime rather than duplicated — SSOT).
 *
 * Topology does NOT live here. The mapping is identical everywhere:
 * a delegated account's `bootstrapInboxId` maps onto `identity.inboxId`, and
 * what that field MEANS is decided by the runtime's inbox ROLE at boot —
 * the browser/desktop legacy role seeds the runtime primary from it (their
 * ceremony inbox IS their lifetime inbox), while the mobile portable role
 * treats it as enrollment metadata only (the ≠-bootstrap defense) and
 * resolves the runtime inbox from the claim store's portable primary.
 *
 * Pure and platform-neutral: no storage, no crypto, no providers — shape
 * validation and projection only.
 *
 * @param {object} account — an unlockKeystoreAccount result.
 * @returns {{hasAdminRoot: boolean, identity: object, deviceKey: object}}
 */
export function mapUnlockedAccountToRuntimeIdentity(account) {
  if (!account || typeof account !== "object") {
    throw new Error("mapUnlockedAccountToRuntimeIdentity requires the unlocked account");
  }
  const hasAdminRoot = account.hasAdminRoot !== false;
  const identityKeyPair = account.identityKeyPair && typeof account.identityKeyPair === "object"
    ? account.identityKeyPair
    : null;
  const deviceKeyPair = account.deviceKeyPair && typeof account.deviceKeyPair === "object"
    ? account.deviceKeyPair
    : null;
  if (!deviceKeyPair || !deviceKeyPair.publicKeyB64 || !deviceKeyPair.privateKeyB64) {
    throw new Error("mapUnlockedAccountToRuntimeIdentity: account is missing deviceKeyPair");
  }
  if (hasAdminRoot && (!identityKeyPair || !identityKeyPair.publicKeyB64 || !identityKeyPair.privateKeyB64)) {
    throw new Error("mapUnlockedAccountToRuntimeIdentity: primary account is missing identityKeyPair");
  }
  const accountId = String(account.accountId || "").trim();
  if (!accountId) {
    throw new Error("mapUnlockedAccountToRuntimeIdentity: account is missing accountId");
  }
  const publicKeyB64 = hasAdminRoot
    ? identityKeyPair.publicKeyB64
    : String(account.identityPublicKey || "").trim();
  if (!publicKeyB64) {
    throw new Error("mapUnlockedAccountToRuntimeIdentity: account is missing the account signing PUBLIC key");
  }
  const deviceId = String(account.deviceId || "").trim();
  if (!deviceId) {
    throw new Error("mapUnlockedAccountToRuntimeIdentity: account is missing deviceId");
  }
  return {
    hasAdminRoot,
    identity: {
      accountId,
      publicKeyB64,
      privateKeyB64: hasAdminRoot ? identityKeyPair.privateKeyB64 : "",
      hasAdminRoot,
      accountIdentityDhKeyPair: account.accountIdentityDhKeyPair || null,
      certChain: hasAdminRoot ? null : account.certChain,
      // R3: the envelope's ceremony inbox is `bootstrapInboxId`; the runtime
      // identity's `inboxId` carries it verbatim for a delegated account.
      // Which INBOX the runtime actually claims is the boot role's decision,
      // never this mapping's.
      inboxId: hasAdminRoot ? null : (account.bootstrapInboxId === undefined ? null : account.bootstrapInboxId),
    },
    deviceKey: {
      deviceId,
      deviceKeyPair,
    },
  };
}
