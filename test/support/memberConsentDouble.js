// Test double for the account-key authority that signs/verifies group
// membership-consent proofs (REZ-2). Synthetic test account IDs (rez:acct:bob)
// are NOT derived from real keys, so the real verifier (which checks
// deriveAccountIdFromPublicKey(pub) === accountId) can't be used here. This
// permissive double accepts any structurally-present proof, letting the
// membership/fan-out tests stay focused on roster logic. The REAL proof path —
// that a forged or wrong-account proof is REJECTED — is covered with real
// keypairs in test/server.member-consent.test.js.

const FAKE_PUB = "TESTPUBKEY";
const FAKE_SIG_B64 = "U0lH"; // base64("SIG")

export function permissiveAccountAuthority() {
  return {
    signer: {
      getSignerRef() {
        return { accountId: "test", keyId: "test", alg: "ed25519", signerPublicKeyB64: FAKE_PUB };
      },
      async sign() { return new Uint8Array([1, 2, 3]); },
    },
    verifier: {
      async verify() { return true; },
    },
  };
}

// Install the permissive authority on a constructed ChatServerApp's bus runtime.
export function withConsentAuthority(app) {
  app.bus.runtime.accountAuthority = permissiveAccountAuthority();
  return app;
}

// A well-formed (test-only) consent proof to attach to a hand-built member.join
// op or member.contact entry so it passes the structural presence checks; the
// permissive verifier above then accepts it.
export function testConsentProof() {
  return { joinerSignerPublicKeyB64: FAKE_PUB, joinerSigB64: FAKE_SIG_B64 };
}
