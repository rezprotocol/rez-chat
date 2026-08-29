import { REZ_CONTRACT_TYPES } from "@rezprotocol/sdk/client";

const T = REZ_CONTRACT_TYPES;

/**
 * The node identity a claim must be delegated to, read from the LIVE session.
 * Fail loud when unavailable — a claim delegated to a guessed node identity
 * is a claim the relay mesh will never honor.
 */
export function resolveNodeIdentity(sdk) {
  const info = sdk && typeof sdk.getSessionInfo === "function" ? sdk.getSessionInfo() : null;
  const nodeKeyId = info && typeof info.nodeKeyId === "string" ? info.nodeKeyId.trim() : "";
  const nodePublicKeyB64 = info && typeof info.nodePublicKeyB64 === "string" ? info.nodePublicKeyB64.trim() : "";
  const relayKeyId = info && typeof info.relayKeyId === "string" ? info.relayKeyId.trim() : "";
  if (!nodeKeyId || !nodePublicKeyB64 || !relayKeyId) {
    throw new Error("inboxClaimWire: node identity unavailable from the SDK session");
  }
  return { nodeKeyId, nodePublicKeyB64, relayKeyId };
}

/**
 * The ONE inbox-claim wire round-trip (SSOT, extracted from
 * ServerRuntimeService in P1.3b so the portable-inbox establishment cannot
 * drift from the session-bind path): build the attestation + node delegation
 * from the claim store, send INBOX_CLAIM over the given session, and record
 * the ACCEPTED lease from the acceptance seam — the exact delegation that was
 * sent, only after the round-trip succeeded (M3 pins 1/3). A failed round-trip
 * throws having recorded nothing. A local lease-persist failure after a
 * successful claim is log-only: the session IS bound; stale-or-absent lease
 * state fails toward "due" at the next wake — the safe direction.
 *
 * Callers own everything around this: M6 re-mint recovery, retries, debug
 * tracing. This function is one attempt, verbatim.
 */
export async function registerInboxClaimOnSession({
  sdk,
  claimStore,
  inboxId,
  retentionClass = "transient",
  clock = () => Date.now(),
  logger = console,
} = {}) {
  if (!sdk || typeof sdk.sendRequest !== "function") {
    throw new Error("registerInboxClaimOnSession requires a connected sdk client");
  }
  if (!claimStore) throw new Error("registerInboxClaimOnSession requires claimStore");
  if (typeof inboxId !== "string" || !inboxId.trim()) {
    throw new Error("registerInboxClaimOnSession requires inboxId");
  }
  const nodeIdentity = resolveNodeIdentity(sdk);
  const attestation = await claimStore.createReattestation(inboxId, { clock });
  const delegation = await claimStore.createNodeDelegation({
    inboxId,
    nodeKeyId: nodeIdentity.nodeKeyId,
    nodePublicKeyB64: nodeIdentity.nodePublicKeyB64,
    relayKeyId: nodeIdentity.relayKeyId,
    retentionClass,
    clock,
  });
  const claimBody = {
    inboxId: attestation.inboxId,
    claimantPublicKeyB64: attestation.claimantPublicKeyB64,
    claimedAtMs: attestation.claimedAtMs,
    signatureB64: attestation.claimSignatureB64,
    nodeDelegation: {
      nodeKeyId: delegation.nodeKeyId,
      nodePublicKeyB64: delegation.nodePublicKeyB64,
      relayKeyId: delegation.relayKeyId,
      issuedAtMs: delegation.issuedAtMs,
      expiresAtMs: delegation.expiresAtMs,
      delegationSigB64: delegation.delegationSigB64,
    },
  };
  // Lease L1: v2 claims/leases carry their signed close-key, generation and
  // retention fields; legacy claims keep the legacy body untouched.
  if (Number.isInteger(attestation.generation)) {
    claimBody.closePublicKeyB64 = attestation.closePublicKeyB64;
    claimBody.generation = attestation.generation;
  }
  if (Number.isInteger(delegation.generation)) {
    claimBody.nodeDelegation.generation = delegation.generation;
    claimBody.nodeDelegation.retentionClass = delegation.retentionClass;
  }
  await sdk.sendRequest({
    type: T.INBOX_CLAIM,
    body: claimBody,
    expectedResponseType: T.INBOX_CLAIM_RES,
  });
  // M3 pin 1: persist lease state ONLY from the acceptance seam. Guarded on
  // the method so injected claim-store doubles predating M3 keep working.
  if (typeof claimStore.recordAcceptedLease === "function") {
    try {
      await claimStore.recordAcceptedLease({
        inboxId,
        issuedAtMs: delegation.issuedAtMs,
        expiresAtMs: delegation.expiresAtMs,
        retentionClass: typeof delegation.retentionClass === "string" && delegation.retentionClass
          ? delegation.retentionClass
          : "transient",
      });
    } catch (err) {
      logger.error("registerInboxClaimOnSession accepted-lease persist failed (renewal will re-derive as due)", {
        inboxId,
        message: err && err.message ? err.message : String(err),
      });
    }
  }
  return { delegation };
}
