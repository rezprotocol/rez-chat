// REZ-2 (membership consent) — REAL-KEY security coverage. The synthetic-ID group
// tests use a permissive authority double; this file uses real Ed25519 keypairs
// (accountId = hash(pubkey)) to prove the REJECTION cases that close roster
// injection: a proof only verifies when its key actually derives to the claimed
// account AND the signature covers { groupId, accountId }. The positive end-to-end
// path (multi-hop mesh conveyance) is covered by server.invites.cross-leaf.e2e.

import test from "node:test";
import assert from "node:assert/strict";

import { NodeCryptoProvider } from "@rezprotocol/node";
import { bytesToBase64, deriveAccountIdFromPublicKey } from "@rezprotocol/sdk/client";
import { buildChatServerInviteAuthority } from "../src/server/bootstrap/bootstrapChatServer.js";
import { signMemberJoinProof, verifyMemberJoinProof } from "../src/records/payloads/memberJoinProof.js";

const CRYPTO = new NodeCryptoProvider();
const GROUP_ID = "grp_consent";

function makeIdentity() {
  const kp = CRYPTO.generateSigningKeyPair();
  return {
    accountId: deriveAccountIdFromPublicKey(kp.publicKey),
    publicKeyB64: bytesToBase64(kp.publicKey),
    privateKeyB64: bytesToBase64(kp.privateKey),
  };
}

function authorityFor(identity) {
  return buildChatServerInviteAuthority({ accountId: identity.accountId, identity, cryptoProvider: CRYPTO });
}

test("a valid self-signed consent proof verifies", async () => {
  const alice = makeIdentity();
  const aliceAuth = authorityFor(alice);
  const verifier = authorityFor(makeIdentity()); // any verifier works (cross-account)
  const proof = await signMemberJoinProof({ signer: aliceAuth.signer, groupId: GROUP_ID, accountId: alice.accountId });
  const ok = await verifyMemberJoinProof({
    authority: verifier, groupId: GROUP_ID, accountId: alice.accountId, ...proof,
  });
  assert.equal(ok, true);
});

test("a proof transplanted onto a DIFFERENT accountId is rejected", async () => {
  const alice = makeIdentity();
  const mallory = makeIdentity();
  const aliceAuth = authorityFor(alice);
  const verifier = authorityFor(makeIdentity());
  // Alice's real proof, but presented as if it were Mallory's membership.
  const proof = await signMemberJoinProof({ signer: aliceAuth.signer, groupId: GROUP_ID, accountId: alice.accountId });
  const ok = await verifyMemberJoinProof({
    authority: verifier, groupId: GROUP_ID, accountId: mallory.accountId, ...proof,
  });
  assert.equal(ok, false, "Alice's key does not derive to Mallory's accountId");
});

test("a proof FORGED by another key for the victim's account is rejected", async () => {
  const alice = makeIdentity();
  const mallory = makeIdentity();
  const malloryAuth = authorityFor(mallory);
  const verifier = authorityFor(makeIdentity());
  // Mallory signs a proof CLAIMING Alice's account — but with Mallory's own key.
  const forged = await signMemberJoinProof({ signer: malloryAuth.signer, groupId: GROUP_ID, accountId: alice.accountId });
  const ok = await verifyMemberJoinProof({
    authority: verifier, groupId: GROUP_ID, accountId: alice.accountId, ...forged,
  });
  assert.equal(ok, false, "Mallory's key does not derive to Alice's accountId");
});

test("a proof bound to a DIFFERENT group is rejected", async () => {
  const alice = makeIdentity();
  const aliceAuth = authorityFor(alice);
  const verifier = authorityFor(makeIdentity());
  const proof = await signMemberJoinProof({ signer: aliceAuth.signer, groupId: GROUP_ID, accountId: alice.accountId });
  const ok = await verifyMemberJoinProof({
    authority: verifier, groupId: "grp_other", accountId: alice.accountId, ...proof,
  });
  assert.equal(ok, false, "the signature covers the original groupId, not grp_other");
});

test("a proof's bound displayName cannot be tampered (TRUST-3)", async () => {
  const alice = makeIdentity();
  const aliceAuth = authorityFor(alice);
  const verifier = authorityFor(makeIdentity());
  // Alice consents to membership under the name "Alice".
  const proof = await signMemberJoinProof({
    signer: aliceAuth.signer, groupId: GROUP_ID, accountId: alice.accountId, displayName: "Alice",
  });
  // Same proof verifies under the signed name...
  assert.equal(await verifyMemberJoinProof({
    authority: verifier, groupId: GROUP_ID, accountId: alice.accountId, displayName: "Alice", ...proof,
  }), true);
  // ...but a forwarder presenting Alice's verified account under a DIFFERENT name
  // is rejected — the name is bound into the signature.
  assert.equal(await verifyMemberJoinProof({
    authority: verifier, groupId: GROUP_ID, accountId: alice.accountId, displayName: "Mallory", ...proof,
  }), false, "tampering the displayName breaks the proof");
});

test("a missing/empty proof is rejected", async () => {
  const alice = makeIdentity();
  const verifier = authorityFor(makeIdentity());
  assert.equal(await verifyMemberJoinProof({
    authority: verifier, groupId: GROUP_ID, accountId: alice.accountId,
    joinerSignerPublicKeyB64: "", joinerSigB64: "",
  }), false);
});
