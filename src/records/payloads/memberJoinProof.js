import { base64ToBytes, bytesToBase64, canonicalJSONStringify } from "@rezprotocol/sdk/client";

// Membership-consent proof (REZ-2). A joiner signs, with their ACCOUNT identity
// key, a canonical statement binding their accountId to the group. The signature
// is the cryptographic proof that this account consented to be a member of THIS
// group — so a malicious member can no longer inject an arbitrary (or victim's)
// accountId into other members' rosters via member.join / member.contact.
//
// Bound fields are { groupId, accountId, displayName }: consent to membership is
// permanent (once you joined, you agreed to be associated with the group under that
// self-chosen name), so the proof is intentionally replay-safe and time-independent.
// Binding displayName means a forwarder re-advertising you via member.contact cannot
// rename your account to a THIRD party's name — the signature breaks if the name is
// tampered. It conveys cleanly through the invite-tree mesh. Re-admission of a KICKED
// member is a separate concern, still gated by the inviter-side anti-resurrection
// rule and by ensureMembership never reviving a removed row — a reusable consent
// proof cannot undo a kick.
//
// displayName is NORMALIZED identically here and in storage (trimmed) so the signed
// value round-trips through the roster and re-advertisement without mismatch.

export const MEMBER_JOIN_PROOF_KIND = "rez.member.join.proof.v1";

export function normalizeMemberDisplayName(displayName) {
  return String(displayName == null ? "" : displayName).trim();
}

export function canonicalMemberJoinProofBytes({ groupId, accountId, displayName } = {}) {
  return new TextEncoder().encode(canonicalJSONStringify({
    v: 1,
    kind: MEMBER_JOIN_PROOF_KIND,
    groupId: String(groupId || ""),
    accountId: String(accountId || ""),
    displayName: normalizeMemberDisplayName(displayName),
  }));
}

// Produce { joinerSignerPublicKeyB64, joinerSigB64 } for the local owner's
// membership in `groupId`, using the account-key signer from the bus authority.
export async function signMemberJoinProof({ signer, groupId, accountId, displayName = "" } = {}) {
  if (!signer || typeof signer.sign !== "function" || typeof signer.getSignerRef !== "function") {
    throw new Error("signMemberJoinProof requires an account-key signer");
  }
  const ref = signer.getSignerRef();
  const signerPublicKeyB64 = ref && typeof ref.signerPublicKeyB64 === "string" ? ref.signerPublicKeyB64 : "";
  if (!signerPublicKeyB64) throw new Error("signMemberJoinProof: signer has no public key");
  const sigBytes = await signer.sign(canonicalMemberJoinProofBytes({ groupId, accountId, displayName }));
  return { joinerSignerPublicKeyB64: signerPublicKeyB64, joinerSigB64: bytesToBase64(sigBytes) };
}

// Verify a membership-consent proof against the account-key verifier. Returns true
// only when the proof's public key derives to `accountId` (checked inside the
// verifier) AND the signature covers the canonical { groupId, accountId, displayName }
// bytes (so a forwarder cannot alter the verified member's name).
export async function verifyMemberJoinProof({
  authority, groupId, accountId, displayName = "", joinerSignerPublicKeyB64, joinerSigB64,
} = {}) {
  if (!authority || !authority.verifier || typeof authority.verifier.verify !== "function") return false;
  if (!authority.signer || typeof authority.signer.getSignerRef !== "function") return false;
  const acct = typeof accountId === "string" ? accountId.trim() : "";
  const pub = typeof joinerSignerPublicKeyB64 === "string" ? joinerSignerPublicKeyB64.trim() : "";
  const sigB64 = typeof joinerSigB64 === "string" ? joinerSigB64.trim() : "";
  if (!acct || !pub || !sigB64) return false;
  const localRef = authority.signer.getSignerRef();
  let sigBytes;
  try {
    sigBytes = base64ToBytes(sigB64);
  } catch {
    return false;
  }
  // The verifier ties signerRef.signerPublicKeyB64 -> accountId via
  // deriveAccountIdFromPublicKey, so passing acct as the signerRef.accountId means
  // a proof only verifies when its key actually derives to the claimed account.
  return authority.verifier.verify({
    signerRef: {
      accountId: acct,
      keyId: localRef && localRef.keyId ? localRef.keyId : "",
      alg: localRef && localRef.alg ? localRef.alg : "",
      signerPublicKeyB64: pub,
    },
    bytes: canonicalMemberJoinProofBytes({ groupId, accountId: acct, displayName }),
    sigBytes,
  });
}
