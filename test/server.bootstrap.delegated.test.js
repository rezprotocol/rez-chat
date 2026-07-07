// S2.5 S9 K3 — the delegated (cert-mode) chat-server bootstrap, un-mocked.
//
// A hand-built delegation (real B root + device key C + single-hop
// AccountDeviceCapabilityV1 chain + account X25519 DH key — exactly what the
// K4 vault produces from a v3 keystore) boots the REAL bootstrapChatServer:
// real FsStorageProvider (device-key-rooted at-rest encryption), real
// ensureChatServerIdentity (delegated row), real InboxClaimant (C claims),
// real PeerLinkService in cert-mode, real C-signed account binding, and a
// real ChatServerApp whose SDK identity is the delegated shape (no account
// priv + chain — the K2 createRezClient gate). The account private key is
// ZEROED before boot: any latent use fails cryptographically. Live network
// session auth + cross-leaf invite acceptance is the K5 local-mesh e2e.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  bytesToBase64,
  deriveAccountIdFromPublicKey,
  verifyDurableRecordV2,
  DeviceRegistrationV1,
  AccountDeviceCapabilityV1,
  ACCOUNT_DEVICE_CAPABILITY_PURPOSE,
} from "@rezprotocol/core";
import { NodeCryptoProvider } from "@rezprotocol/node";
import { bootstrapChatServer } from "../src/server/bootstrap/bootstrapChatServer.js";

const CRYPTO = new NodeCryptoProvider();
const NOW = Date.now();
const FAR = NOW + 7 * 24 * 60 * 60 * 1000;

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function buildLeafCert({ accountPubB64, accountPrivBytes, granteePubB64, capabilities }) {
  const fields = {
    v: 1,
    purpose: ACCOUNT_DEVICE_CAPABILITY_PURPOSE,
    accountIdentityPublicKeyB64: accountPubB64,
    parentCertId: null,
    granteeDevicePublicKeyB64: granteePubB64,
    granteeDeviceId: DeviceRegistrationV1.deviceIdFor(granteePubB64),
    capabilities,
    maxDelegationDepth: 0,
    issuedAtMs: NOW - 1000,
    expiresAtMs: FAR,
    signerPublicKeyB64: accountPubB64,
  };
  const certId = AccountDeviceCapabilityV1.deriveCertId(fields);
  const sigBytes = CRYPTO.sign({ privateKey: accountPrivBytes, msg: AccountDeviceCapabilityV1.signableBytes({ ...fields, certId }) });
  return new AccountDeviceCapabilityV1({ ...fields, certId, sig: { alg: "ed25519", sigB64: bytesToBase64(sigBytes) } });
}

// Mint the delegation the way the ceremony/vault would: B signs the cert for a
// locally-minted C, the account X25519 DH key rides along, then B's private
// key is ZEROED — the booted stack must never need it again.
function makeDelegation() {
  const b = CRYPTO.generateSigningKeyPair();
  const c = CRYPTO.generateSigningKeyPair();
  const dh = CRYPTO.dhGenerateKeyPair(); // X25519 SPKI/PKCS8
  const accountPubB64 = bytesToBase64(b.publicKey);
  const accountId = deriveAccountIdFromPublicKey(b.publicKey);
  const deviceKeyPair = { publicKeyB64: bytesToBase64(c.publicKey), privateKeyB64: bytesToBase64(c.privateKey) };
  const leafCert = buildLeafCert({
    accountPubB64,
    accountPrivBytes: b.privateKey,
    granteePubB64: deviceKeyPair.publicKeyB64,
    capabilities: ["peerLink.create", "deviceSet.publish"],
  });
  b.privateKey.fill(0);

  return {
    accountId,
    accountPubB64,
    deviceKey: {
      deviceId: DeviceRegistrationV1.deviceIdFor(deviceKeyPair.publicKeyB64),
      deviceKeyPair,
    },
    chatServerIdentity: {
      accountId,
      publicKeyB64: accountPubB64,
      privateKeyB64: null,
      hasAdminRoot: false,
      certChain: [leafCert.toJSON()],
      accountIdentityDhKeyPair: {
        publicKeyB64: bytesToBase64(dh.publicKey),
        privateKeyB64: bytesToBase64(dh.privateKey),
      },
    },
  };
}

test("a delegated identity boots a cert-mode chat server: C claims, C binds, C signs invites; B priv never exists", async () => {
  const d = makeDelegation();
  const bootstrapped = await bootstrapChatServer({
    nodeDataDir: tmpDir("rez-boot-del-1-"),
    wsUrl: "ws://127.0.0.1:1/ws",
    expectedChatServerIdentity: d.chatServerIdentity,
    deviceKey: d.deviceKey,
  });

  // The persisted identity row is delegated: no priv, C's self-cert deviceId.
  assert.equal(bootstrapped.identity.hasAdminRoot, false);
  assert.equal(bootstrapped.identity.privateKeyB64, "");
  assert.equal(bootstrapped.identity.deviceId, d.deviceKey.deviceId);

  // PeerLinkService constructed in cert-mode.
  assert.equal(bootstrapped.peerLinkService.hasAdminRoot, false);

  // The inbox claimant is the DEVICE key C, not the account identity.
  assert.equal(bootstrapped.inboxClaimant.claimantPublicKeyB64, d.deviceKey.deviceKeyPair.publicKeyB64);

  // The account-key authority signer THROWS — any residual account-sign
  // consumer fails loud instead of missigning.
  await assert.rejects(
    () => bootstrapped.peerLinkService.signer.sign(new Uint8Array([1, 2, 3])),
    /delegated and holds no account root key \(B-sign\)/,
  );

  // The self-provisioned x3dh binding is C-signed with the signer surfaced.
  const bound = await bootstrapped.peerLinkService._requireBoundX3dhIdentity(d.accountId);
  assert.equal(bound.accountBinding.accountIdentityPublicKeyB64, d.accountPubB64, "the binding anchors at B");
  assert.equal(bound.accountBinding.accountBindingSignerPublicKeyB64, d.deviceKey.deviceKeyPair.publicKeyB64, "C is the binding signer");

  // A REAL invite through the booted service: delegated envelope + V2 record.
  const created = await bootstrapped.peerLinkService.createInvite({
    kind: "direct",
    maxUses: 1,
    expiresAtMs: Date.now() + 60_000,
  });
  const stored = await bootstrapped.peerLinkService.getStoredInviteEnvelope(d.accountId, created.inviteId);
  assert.equal(stored.envelope.signerRef.keyId, "invite-ed25519-delegated-v1");
  assert.equal(stored.envelope.signerRef.signerPublicKeyB64, d.deviceKey.deviceKeyPair.publicKeyB64);
  assert.equal(Array.isArray(stored.envelope.certChain) && stored.envelope.certChain.length, 1);
  assert.equal(created.durableRecord.v, 2);
  assert.equal(created.durableRecord.ownerPublicKeyB64, d.accountPubB64, "the record owner/slot stays B");
  const verdict = await verifyDurableRecordV2({ record: created.durableRecord, crypto: CRYPTO, nowMs: Date.now() });
  assert.equal(verdict.ok, true, verdict.reason);
  assert.equal(verdict.mode, "delegated");
});

test("a delegated identity without deviceKey fails loud", async () => {
  const d = makeDelegation();
  await assert.rejects(
    () => bootstrapChatServer({
      nodeDataDir: tmpDir("rez-boot-del-2-"),
      wsUrl: "ws://127.0.0.1:1/ws",
      expectedChatServerIdentity: d.chatServerIdentity,
      deviceKey: null,
    }),
    /delegated chat-server identity requires deviceKey/,
  );
});

test("a delegated identity without a certChain fails loud", async () => {
  const d = makeDelegation();
  await assert.rejects(
    () => bootstrapChatServer({
      nodeDataDir: tmpDir("rez-boot-del-3-"),
      wsUrl: "ws://127.0.0.1:1/ws",
      expectedChatServerIdentity: { ...d.chatServerIdentity, certChain: [] },
      deviceKey: d.deviceKey,
    }),
    /delegated chat-server identity requires a non-empty certChain/,
  );
});

test("direct regression: a primary identity boots exactly as before (admin root, B-signed binding, V1 invite)", async () => {
  const b = CRYPTO.generateSigningKeyPair();
  const dh = CRYPTO.dhGenerateKeyPair();
  const identity = {
    accountId: deriveAccountIdFromPublicKey(b.publicKey),
    publicKeyB64: bytesToBase64(b.publicKey),
    privateKeyB64: bytesToBase64(b.privateKey),
    accountIdentityDhKeyPair: {
      publicKeyB64: bytesToBase64(dh.publicKey),
      privateKeyB64: bytesToBase64(dh.privateKey),
    },
  };
  const bootstrapped = await bootstrapChatServer({
    nodeDataDir: tmpDir("rez-boot-dir-1-"),
    wsUrl: "ws://127.0.0.1:1/ws",
    expectedChatServerIdentity: identity,
  });
  assert.equal(bootstrapped.identity.hasAdminRoot, true);
  assert.equal(bootstrapped.identity.privateKeyB64, identity.privateKeyB64);
  assert.equal(bootstrapped.peerLinkService.hasAdminRoot, true);
  const bound = await bootstrapped.peerLinkService._requireBoundX3dhIdentity(identity.accountId);
  assert.equal("accountBindingSignerPublicKeyB64" in bound.accountBinding, false, "a direct binding gains NO signer field");

  const created = await bootstrapped.peerLinkService.createInvite({
    kind: "direct",
    maxUses: 1,
    expiresAtMs: Date.now() + 60_000,
  });
  const stored = await bootstrapped.peerLinkService.getStoredInviteEnvelope(identity.accountId, created.inviteId);
  assert.equal(stored.envelope.signerRef.keyId, "invite-ed25519-v1");
  assert.equal("certChain" in stored.envelope, false);
  assert.equal(created.durableRecord.v, 1, "the direct durable record stays DurableRecordV1");
});
