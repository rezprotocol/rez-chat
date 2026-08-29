import { canonicalJSONStringify } from "@rezprotocol/sdk/client";
import { WirePayloadRecord } from "../WirePayloadRecord.js";
import { verifySignedAccountClaim } from "./originalMessageShapes.js";

/**
 * MessageCommitAckV1 (plans/MESSAGE_COMMIT_ACK_PLAN.md §2): the recipient's
 * sender-verifiable proof that this exact OriginalMessage — named by its
 * MessageFingerprint, the ONE content identity — was authenticated, admitted,
 * appended to the immutable fact log, and committed into the recipient
 * account's projection. Emitted only AFTER the projection commit, and only
 * inside the sealed E2EE peer channel (frozen §8.4: never a MailboxProvider
 * primitive). Replaces the legacy `rez.delivery.ack` for SIGNED-era messages
 * (approved decision 1 — hard cutover by message regime).
 *
 * Credential-vs-semantic split (frozen at AE-1 close): everything capable of
 * changing what the ack CLAIMS is inside the signed bytes — messageId
 * (correlation), messageFingerprint (THE claim), threadId (the claim's
 * signed thread binding), recipientAccountId/recipientDeviceId/
 * recipientAuthorityEpoch/signerPublicKeyB64 (who committed), committedAtMs.
 * `recipientCertChain` and `sig` stay OUTSIDE: credential material used to
 * establish the signer may vary across attempts; the claim must not.
 *
 * Idempotent by fingerprint (frozen at approval): every valid ack for
 * fingerprint F is evidence of the same terminal sender-side condition —
 * "F committed somewhere in the recipient account" — so the first verified
 * proof completes the pending state and later ones are harmless duplicates,
 * including acks from siblings outside the original fan-out (decision 2).
 */
export const MESSAGE_COMMIT_ACK_KIND = "rez.chat.commit-ack.v1";

export class MessageCommitAckV1 extends WirePayloadRecord {
  static KIND = MESSAGE_COMMIT_ACK_KIND;
  static schema = {
    messageId: { type: "string", required: true, trim: true },
    messageFingerprint: { type: "string", required: true, trim: true },
    threadId: { type: "string", required: true, trim: true },
    recipientAccountId: { type: "string", required: true, trim: true },
    // Empty in direct mode when the primary carries no device identity; the
    // verifier requires it (self-cert of the signer key) in cert mode.
    recipientDeviceId: { type: "string", trim: true },
    // NOT schema-required: epoch 0 is a legitimate value and SchemaRecord's
    // required-int treats zero as missing; validate() enforces integer >= 0.
    recipientAuthorityEpoch: { type: "int" },
    signerPublicKeyB64: { type: "string", required: true, trim: true },
    committedAtMs: { type: "int", required: true },
    // Verification material — OUTSIDE the signed bytes.
    recipientCertChain: { type: "array" },
    sig: { type: "string", required: true, trim: true },
  };

  // The exact bytes the recipient signs and the sender recomputes. Every
  // field is normalized HERE (frozen at AE-2 close: canonical signed bytes
  // must normalize semantic absence explicitly; schema coercion is not
  // canonicalization) so the sender's pre-coercion input and the receiver's
  // record-coerced JSON canonicalize identically.
  static signableBytes({
    messageId,
    messageFingerprint,
    threadId,
    recipientAccountId,
    recipientDeviceId = "",
    recipientAuthorityEpoch,
    signerPublicKeyB64,
    committedAtMs,
  } = {}) {
    return new TextEncoder().encode(canonicalJSONStringify({
      kind: MESSAGE_COMMIT_ACK_KIND,
      messageId: typeof messageId === "string" ? messageId.trim() : "",
      messageFingerprint: typeof messageFingerprint === "string" ? messageFingerprint.trim() : "",
      threadId: typeof threadId === "string" ? threadId.trim() : "",
      recipientAccountId: typeof recipientAccountId === "string" ? recipientAccountId.trim() : "",
      recipientDeviceId: typeof recipientDeviceId === "string" ? recipientDeviceId.trim() : "",
      recipientAuthorityEpoch: Number.isInteger(recipientAuthorityEpoch) && recipientAuthorityEpoch >= 0
        ? recipientAuthorityEpoch
        : 0,
      signerPublicKeyB64: typeof signerPublicKeyB64 === "string" ? signerPublicKeyB64.trim() : "",
      committedAtMs: Number.isInteger(committedAtMs) && committedAtMs > 0 ? committedAtMs : 0,
    }));
  }

  validate() {
    super.validate();
    this.assert(Number.isInteger(this.recipientAuthorityEpoch) && this.recipientAuthorityEpoch >= 0,
      "MessageCommitAckV1.recipientAuthorityEpoch must be an integer >= 0");
    this.assert(Number.isInteger(this.committedAtMs) && this.committedAtMs > 0,
      "MessageCommitAckV1.committedAtMs must be an integer > 0");
  }
}

/**
 * Sender-side acceptance verifier (plan §2, frozen failure distinction §8).
 * The ack is EVIDENCE, admitted fail-closed — this covers the record-local
 * steps (self-certifying recipient identity, deviceId self-cert in cert
 * mode, signature over the canonical bytes, verifyAccountAuthority with the
 * caller-supplied CURRENT revocation state). The pending-fact fingerprint
 * match (step 1) lives at the call site — it needs the sender's store.
 *
 * `revocationState` semantics mirror admission: the caller passes the
 * freshest ESTABLISHED state (null = established-no-revocations); a
 * cannot-establish source must be handled BEFORE calling (leave the ack
 * unconsumed — never "unknown authority state means probably okay").
 * Direct-mode acks carry no revocable credential, so revocation state is
 * structurally not an input there.
 *
 * @returns {Promise<{ok:boolean, mode?:"direct"|"delegated", reason?:string}>}
 */
export async function verifyCommitAckForAcceptance({ ackJson, cryptoProvider, nowMs, revocationState = null } = {}) {
  if (!cryptoProvider || typeof cryptoProvider.verify !== "function") {
    return { ok: false, reason: "cryptoProvider.verify required" };
  }
  if (typeof nowMs !== "number" || !Number.isFinite(nowMs)) {
    return { ok: false, reason: "nowMs required" };
  }
  const p = ackJson && typeof ackJson === "object" ? ackJson : {};
  if (p.kind !== MESSAGE_COMMIT_ACK_KIND) {
    return { ok: false, reason: "not a MessageCommitAckV1 payload" };
  }
  const fingerprint = typeof p.messageFingerprint === "string" ? p.messageFingerprint.trim() : "";
  if (!fingerprint) {
    return { ok: false, reason: "messageFingerprint required (the claim)" };
  }
  const sigB64 = typeof p.sig === "string" ? p.sig.trim() : "";
  if (!sigB64) {
    return { ok: false, reason: "sig required" };
  }
  const chain = Array.isArray(p.recipientCertChain) && p.recipientCertChain.length > 0
    ? p.recipientCertChain
    : null;
  return verifySignedAccountClaim({
    signableBytes: MessageCommitAckV1.signableBytes(p),
    sigB64,
    signerPublicKeyB64: typeof p.signerPublicKeyB64 === "string" ? p.signerPublicKeyB64.trim() : "",
    accountId: typeof p.recipientAccountId === "string" ? p.recipientAccountId.trim() : "",
    deviceId: typeof p.recipientDeviceId === "string" ? p.recipientDeviceId.trim() : "",
    certChain: chain,
    cryptoProvider,
    nowMs,
    revocationState,
    labels: { accountField: "recipientAccountId", deviceField: "recipientDeviceId" },
  });
}
