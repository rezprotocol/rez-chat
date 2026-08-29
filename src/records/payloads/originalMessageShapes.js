import {
  canonicalJSONStringify,
  base64ToBytes,
  deriveAccountIdFromPublicKey,
  deriveDeviceIdFromPublicKeyB64,
  verifyAccountAuthority,
} from "@rezprotocol/sdk/client";
import { Hash } from "@rezprotocol/sdk/hash";
import { MESSAGE_KIND } from "./ChatMessagePayloadV1.js";
import { MESSAGE_EDIT_KIND } from "./ChatMessageEditPayloadV1.js";
import { MESSAGE_TOMBSTONE_KIND } from "./ChatMessageTombstonePayloadV1.js";
import { REACTION_KIND } from "./ChatReactionPayloadV1.js";

/**
 * OriginalMessage canonical shapes — the SSOT for the signable bytes,
 * the MessageFingerprint, and the admission verifier
 * (plans/ORIGINAL_MESSAGE_ANTIENTROPY_PLAN.md, AE-1).
 *
 * Every producer (the sender's signer in ServerMessagesService) and every
 * verifier (live-ingest admission, sibling-transfer admission in AE-2)
 * builds the bytes from HERE — the claimShapes.js lesson: signed-payload
 * literals kept in lockstep by comments drift.
 *
 * Canonical-bytes rule (FROZEN, plan header): anything capable of changing
 * how a recipient interprets the fact is INSIDE the signed bytes — kind,
 * sender identity (senderAccountId + signerPublicKeyB64 + senderDeviceId),
 * authority epoch, thread binding, messageId, targetFingerprint (mutations),
 * the content, and every order-affecting timestamp the payload carries.
 *
 * Three fields are VERIFICATION MATERIAL, not semantics, and stay OUTSIDE:
 *   - `sig`            — the signature cannot cover itself.
 *   - `contentHash`    — it IS the fingerprint (circular otherwise).
 *   - `senderCertChain`— the proof that the signed-in signerPublicKeyB64
 *     held account authority. Authorship is already pinned inside the bytes
 *     (signerPublicKeyB64 + senderDeviceId); the admission verifier binds
 *     the chain's leaf grantee to that signed-in key, so a chain cannot
 *     reinterpret the fact. Excluding it means a renewed/re-issued chain on
 *     redelivery of the identical fact keeps the SAME fingerprint —
 *     otherwise every cert renewal would masquerade as an integrity
 *     conflict.
 *
 * MessageFingerprint = sha256 hex of the canonical signable bytes. The ONE
 * content identity: digest, duplicate/conflict detection, sibling-transfer
 * verification, and the mutations' `targetFingerprint` edge all use it.
 */

export const ORIGINAL_MESSAGE_MUTATION_KINDS = Object.freeze([
  MESSAGE_EDIT_KIND,
  MESSAGE_TOMBSTONE_KIND,
  REACTION_KIND,
]);

export const ORIGINAL_MESSAGE_KINDS = Object.freeze([
  MESSAGE_KIND,
  ...ORIGINAL_MESSAGE_MUTATION_KINDS,
]);

// Kind → the semantic (signed) field set beyond the shared authorship
// fields. Explicit allowlists: the signable payload is built from named
// fields, never by subtracting envelope fields from whatever arrived — an
// unknown extra field must not silently enter (or silently escape) the
// signed bytes.
const KIND_CONTENT_FIELDS = Object.freeze({
  [MESSAGE_KIND]: Object.freeze(["threadId", "messageId", "text", "inReplyToMessageId", "channelId"]),
  [MESSAGE_EDIT_KIND]: Object.freeze(["threadId", "targetMessageId", "targetFingerprint", "newText", "editedAtMs"]),
  [MESSAGE_TOMBSTONE_KIND]: Object.freeze(["threadId", "targetMessageId", "targetFingerprint", "tombstonedAtMs"]),
  [REACTION_KIND]: Object.freeze(["threadId", "targetMessageId", "targetFingerprint", "emoji", "op", "createdAtMs"]),
});

function str(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function isOriginalMessageKind(kind) {
  return ORIGINAL_MESSAGE_KINDS.includes(kind);
}

export function isOriginalMessageMutationKind(kind) {
  return ORIGINAL_MESSAGE_MUTATION_KINDS.includes(kind);
}

/**
 * Presence verdict for the signed-fact envelope group, which is all-or-none
 * by contract: {signerPublicKeyB64, senderAuthorityEpoch, contentHash, sig}.
 * "partial" is always malformed — callers drop it, never infer around it.
 * (`senderCertChain`/`senderDeviceId` are mode-dependent — cert-mode
 * requirements are enforced by the verifier, not by presence.)
 * @returns {"none"|"all"|"partial"}
 */
export function originalMessageAuthPresence(payloadJson) {
  const p = payloadJson && typeof payloadJson === "object" ? payloadJson : {};
  const flags = [
    str(p.signerPublicKeyB64).length > 0,
    Number.isInteger(p.senderAuthorityEpoch) && p.senderAuthorityEpoch >= 0,
    str(p.contentHash).length > 0,
    str(p.sig).length > 0,
  ];
  const present = flags.filter(Boolean).length;
  if (present === 0) return "none";
  if (present === flags.length) return "all";
  return "partial";
}

/**
 * The canonical semantic object whose canonical-JSON bytes the sender signs
 * and the fingerprint hashes. THROWS on an unknown kind or a missing
 * required semantic field — a malformed fact must never acquire a canonical
 * serialization.
 */
export function signableOriginalMessagePayload(payloadJson) {
  const p = payloadJson && typeof payloadJson === "object" ? payloadJson : {};
  const kind = str(p.kind);
  const contentFields = KIND_CONTENT_FIELDS[kind];
  if (!contentFields) {
    throw new Error("signableOriginalMessagePayload: not an OriginalMessage kind: '" + kind + "'");
  }
  const senderAccountId = str(p.senderAccountId);
  if (!senderAccountId) {
    throw new Error("signableOriginalMessagePayload: senderAccountId required");
  }
  const signerPublicKeyB64 = str(p.signerPublicKeyB64);
  if (!signerPublicKeyB64) {
    throw new Error("signableOriginalMessagePayload: signerPublicKeyB64 required (it is authorship, inside the signed bytes)");
  }
  if (!Number.isInteger(p.senderAuthorityEpoch) || p.senderAuthorityEpoch < 0) {
    throw new Error("signableOriginalMessagePayload: senderAuthorityEpoch must be an integer >= 0 (F6: an unsigned epoch stamp is forgeable)");
  }
  const out = {
    kind,
    senderAccountId,
    signerPublicKeyB64,
    senderDeviceId: str(p.senderDeviceId),
    senderAuthorityEpoch: p.senderAuthorityEpoch,
  };
  for (const field of contentFields) {
    const raw = p[field];
    if (field === "editedAtMs" || field === "tombstonedAtMs" || field === "createdAtMs") {
      if (!Number.isInteger(raw) || raw <= 0) {
        throw new Error("signableOriginalMessagePayload: " + kind + " requires integer " + field + " > 0");
      }
      out[field] = raw;
      continue;
    }
    out[field] = typeof raw === "string" ? raw : "";
  }
  if (!str(out.threadId)) {
    throw new Error("signableOriginalMessagePayload: threadId required (thread binding is signed semantics)");
  }
  if (kind === MESSAGE_KIND && !str(out.messageId)) {
    throw new Error("signableOriginalMessagePayload: messageId required");
  }
  if (isOriginalMessageMutationKind(kind)) {
    if (!str(out.targetMessageId)) {
      throw new Error("signableOriginalMessagePayload: " + kind + " requires targetMessageId");
    }
    // BINDING requirement (plan header): a signed mutation names WHICH fact
    // it mutates by fingerprint — messageId is not a unique fact identity.
    if (!str(out.targetFingerprint)) {
      throw new Error("signableOriginalMessagePayload: " + kind + " requires targetFingerprint (mutations bind to the target fact's fingerprint, never messageId alone)");
    }
  }
  return out;
}

/** The exact bytes the sender signs and every verifier recomputes. */
export function signableOriginalMessageBytes(payloadJson) {
  return new TextEncoder().encode(canonicalJSONStringify(signableOriginalMessagePayload(payloadJson)));
}

/** MessageFingerprint — sha256 hex of the canonical signable bytes. */
export function messageFingerprint(payloadJson) {
  return Hash.sha256Hex(signableOriginalMessageBytes(payloadJson));
}

/**
 * ThreadDigest set hash (AE-2): sha256 hex over the SORTED, DEDUPED
 * fingerprint set. The authoritative reconciliation set is FINGERPRINTS,
 * never messageIds (frozen at AE-1 close): two valid facts sharing one
 * messageId are two distinct facts, and any inventory optimization keyed on
 * messageIds would silently reintroduce collapse semantics.
 */
export function fingerprintSetDigest(fingerprints) {
  const list = Array.isArray(fingerprints)
    ? fingerprints.filter((fp) => typeof fp === "string" && fp.length > 0)
    : [];
  return Hash.sha256Hex([...new Set(list)].sort().join("\n"));
}

/**
 * Shared signed-account-claim verifier — the SSOT for "did THIS signer,
 * holding authority for THIS account, sign THESE canonical bytes":
 *
 *   - the claim identity is self-certifying: the authority anchor (the cert
 *     chain's root account key in cert-mode, the signer itself in direct
 *     mode) must derive the claimed accountId — no directory lookup
 *   - cert-mode: the claimed deviceId must be the self-cert of the signed-in
 *     signer key, and verifyAccountAuthority binds the chain's leaf grantee
 *     to that key
 *   - the signature verifies over the canonical bytes
 *   - verifyAccountAuthority (rez-core) with the caller-supplied CURRENT
 *     revocation state (forward-looking; a record's own epoch stamp is
 *     ordering/audit, never an admission input)
 *
 * Used by verifyOriginalMessageForAdmission (AE-1) and by the
 * MessageCommitAckV1 acceptance verifier — one verification core, two claim
 * shapes. `labels` names the claim's account/device fields so failure
 * reasons stay claim-specific. Fail-closed: {ok:false, reason}, never
 * throws on malformed input.
 *
 * @returns {Promise<{ok:boolean, mode?:"direct"|"delegated", reason?:string}>}
 */
export async function verifySignedAccountClaim({
  signableBytes,
  sigB64,
  signerPublicKeyB64,
  accountId,
  deviceId,
  certChain = null,
  cryptoProvider,
  nowMs,
  revocationState = null,
  labels = { accountField: "accountId", deviceField: "deviceId" },
} = {}) {
  const chain = Array.isArray(certChain) && certChain.length > 0 ? certChain : null;

  let anchorPublicKeyB64;
  if (chain) {
    const root = chain[0] && typeof chain[0] === "object" ? str(chain[0].accountIdentityPublicKeyB64) : "";
    if (!root) {
      return { ok: false, reason: "cert chain root carries no account anchor" };
    }
    anchorPublicKeyB64 = root;
    if (!deviceId) {
      return { ok: false, reason: "cert-mode claim requires " + labels.deviceField + " (the chain grantee's self-cert id)" };
    }
    let expectedDeviceId;
    try {
      expectedDeviceId = deriveDeviceIdFromPublicKeyB64(signerPublicKeyB64);
    } catch (err) {
      return { ok: false, reason: "malformed signerPublicKeyB64: " + (err && err.message ? err.message : "unknown") };
    }
    if (expectedDeviceId !== deviceId) {
      return { ok: false, reason: labels.deviceField + " is not the self-cert of the signer key" };
    }
  } else {
    anchorPublicKeyB64 = signerPublicKeyB64;
  }

  // Self-certifying account identity: the anchor must derive the claimed
  // account id — no directory lookup, nothing to spoof.
  let derivedAccountId;
  try {
    derivedAccountId = deriveAccountIdFromPublicKey(base64ToBytes(anchorPublicKeyB64));
  } catch (err) {
    return { ok: false, reason: "malformed authority anchor key: " + (err && err.message ? err.message : "unknown") };
  }
  if (derivedAccountId !== accountId) {
    return { ok: false, reason: "authority anchor does not derive " + labels.accountField };
  }

  let sigOk;
  try {
    sigOk = await cryptoProvider.verify({
      publicKey: base64ToBytes(signerPublicKeyB64),
      msg: signableBytes,
      sig: base64ToBytes(sigB64),
    });
  } catch (err) {
    return { ok: false, reason: "signature verification failed: " + (err && err.message ? err.message : "unknown") };
  }
  if (sigOk !== true) {
    return { ok: false, reason: "signature invalid over the canonical bytes" };
  }

  const authority = await verifyAccountAuthority({
    expectedAccountIdentityPublicKeyB64: anchorPublicKeyB64,
    requiredCapability: null,
    opSignerPublicKeyB64: signerPublicKeyB64,
    certChain: chain,
    crypto: cryptoProvider,
    nowMs,
    revocationState,
  });
  if (!authority.ok) {
    return { ok: false, reason: "account authority rejected: " + (authority.reason || "unknown") };
  }

  return { ok: true, mode: authority.mode };
}

/**
 * Admission verifier (plan §4) — the sibling/live-path is TRANSPORT, never
 * authority; every signed OriginalMessage is verified as a NEW admission:
 *
 *   1. the canonical bytes rebuild and the fingerprint equals `contentHash`
 *   2. the sender identity is self-certifying: the authority anchor (the
 *      chain's root account key in cert-mode, the signer itself in direct
 *      mode) derives `senderAccountId`
 *   3. cert-mode: `senderDeviceId` is the self-cert of the signed-in
 *      signer key, and the admission-time authority check binds the chain's
 *      leaf grantee to that key
 *   4. the signature verifies over the canonical bytes
 *   5. verifyAccountAuthority (rez-core) — direct or delegated — with the
 *      caller-supplied `revocationState` (forward-looking revocation, rev4
 *      Q4: pass the freshest observed authority state; the record's own
 *      epoch stamp is ordering/audit, never an admission input)
 *
 * Fail-closed: returns {ok:false, reason} — it never throws on malformed
 * input, and it never downgrades a signed record to "unsigned".
 *
 * @returns {Promise<{ok:boolean, mode?:"direct"|"delegated", fingerprint?:string, reason?:string}>}
 */
export async function verifyOriginalMessageForAdmission({ payloadJson, cryptoProvider, nowMs, revocationState = null } = {}) {
  if (!cryptoProvider || typeof cryptoProvider.verify !== "function") {
    return { ok: false, reason: "cryptoProvider.verify required" };
  }
  if (typeof nowMs !== "number" || !Number.isFinite(nowMs)) {
    return { ok: false, reason: "nowMs required" };
  }
  const p = payloadJson && typeof payloadJson === "object" ? payloadJson : {};
  const presence = originalMessageAuthPresence(p);
  if (presence !== "all") {
    return { ok: false, reason: "signed-fact envelope group is " + presence };
  }

  let signableBytes;
  let fingerprint;
  try {
    signableBytes = signableOriginalMessageBytes(p);
    fingerprint = Hash.sha256Hex(signableBytes);
  } catch (err) {
    return { ok: false, reason: "malformed OriginalMessage: " + (err && err.message ? err.message : "unknown") };
  }
  if (fingerprint !== str(p.contentHash)) {
    return { ok: false, reason: "contentHash does not match the canonical-bytes fingerprint" };
  }

  const claim = await verifySignedAccountClaim({
    signableBytes,
    sigB64: str(p.sig),
    signerPublicKeyB64: str(p.signerPublicKeyB64),
    accountId: str(p.senderAccountId),
    deviceId: str(p.senderDeviceId),
    certChain: Array.isArray(p.senderCertChain) && p.senderCertChain.length > 0 ? p.senderCertChain : null,
    cryptoProvider,
    nowMs,
    revocationState,
    labels: { accountField: "senderAccountId", deviceField: "senderDeviceId" },
  });
  if (!claim.ok) {
    return { ok: false, reason: claim.reason };
  }
  return { ok: true, mode: claim.mode, fingerprint };
}
