import {
  base64ToBytes,
  bytesToBase64,
  canonicalJSONStringify,
  deriveAccountIdFromPublicKey,
} from "@rezprotocol/sdk/client";
import { PeerLinkService } from "@rezprotocol/sdk/peer-link";
import { ChatServerApp } from "../app/ChatServerApp.js";
import { InboxClaimant } from "../inbox/InboxClaimant.js";

export function buildChatServerInviteAuthority({ accountId, identity, cryptoProvider, hasAdminRoot = true }) {
  const keyId = "invite-ed25519-v1";
  const alg = "ed25519";
  const privateKey = hasAdminRoot ? base64ToBytes(identity.privateKeyB64) : null;
  const publicKey = base64ToBytes(identity.publicKeyB64);
  const signerPublicKeyB64 = identity.publicKeyB64;
  return {
    signer: {
      getSignerRef() {
        return { accountId, keyId, alg, signerPublicKeyB64 };
      },
      async sign(bytes) {
        if (!hasAdminRoot) {
          throw new Error("chat-server invite authority: this device is delegated and holds no account root key (B-sign) — account-level signing requires the primary device");
        }
        return cryptoProvider.sign({ privateKey, msg: bytes });
      },
    },
    verifier: {
      async verify({ signerRef, bytes, sigBytes } = {}) {
        if (String((signerRef && signerRef.alg) || "") !== alg) return false;
        if (String((signerRef && signerRef.keyId) || "") !== keyId) return false;
        const refAccountId = String((signerRef && signerRef.accountId) || "");
        const refPubB64 = String((signerRef && signerRef.signerPublicKeyB64) || "");
        if (!refAccountId || !refPubB64) return false;
        let refPub;
        try {
          refPub = base64ToBytes(refPubB64);
        } catch {
          return false;
        }
        let derived;
        try {
          derived = deriveAccountIdFromPublicKey(refPub);
        } catch {
          return false;
        }
        if (derived !== refAccountId) return false;
        const verificationKey = refAccountId === accountId ? publicKey : refPub;
        return cryptoProvider.verify({ publicKey: verificationKey, msg: bytes, sig: sigBytes });
      },
    },
  };
}

export async function selfProvisionAccountBinding({ peerLinkService, identity, cryptoProvider, hasAdminRoot = true }) {
  if (!hasAdminRoot) {
    await peerLinkService.selfProvisionDelegatedAccountBinding({ ownerAccountId: identity.accountId });
    return;
  }
  const challenge = await peerLinkService.getOrCreateAccountBindingChallenge({
    ownerAccountId: identity.accountId,
  });
  const x3dhIdentityPublicKeyB64 = String((challenge && challenge.x3dhIdentityPublicKeyB64) || "").trim();
  if (!x3dhIdentityPublicKeyB64) {
    throw new Error("chat runtime PeerLinkService did not yield an X3DH identity");
  }
  const issuedAtMs = Date.now();
  const expiresAtMs = issuedAtMs + 365 * 24 * 60 * 60 * 1000;
  const payload = {
    kind: "x3dh-subkey-binding",
    accountId: identity.accountId,
    x3dhIdentityPublicKeyB64,
    issuedAtMs,
    expiresAtMs,
  };
  const sig = await cryptoProvider.sign({
    privateKey: base64ToBytes(identity.privateKeyB64),
    msg: new TextEncoder().encode(canonicalJSONStringify(payload)),
  });
  await peerLinkService.upsertAccountBinding({
    ownerAccountId: identity.accountId,
    accountBinding: {
      accountId: identity.accountId,
      accountIdentityPublicKeyB64: identity.publicKeyB64,
      x3dhIdentityPublicKeyB64,
      issuedAtMs,
      expiresAtMs,
      accountBindingSigB64: bytesToBase64(sig),
    },
  });
}

export async function bootstrapChatRuntime({
  identity,
  deviceKey = null,
  storageProvider,
  cryptoProvider,
  uplinks,
  expectedNodePublicKeyB64 = "",
  wsFactory = null,
  linksServiceFactory = null,
  deviceLinkServiceFactory = null,
  allowLegacyAccountIdentityDhAdoption = false,
  onLegacyAccountIdentityDhAdopted = null,
  logger = console,
} = {}) {
  if (!identity || typeof identity !== "object") {
    throw new Error("bootstrapChatRuntime requires identity");
  }
  if (!storageProvider || typeof storageProvider.getKeyValueStore !== "function") {
    throw new Error("bootstrapChatRuntime requires storageProvider");
  }
  if (!cryptoProvider || typeof cryptoProvider.sign !== "function") {
    throw new Error("bootstrapChatRuntime requires cryptoProvider");
  }
  if (!Array.isArray(uplinks) || uplinks.length === 0) {
    throw new Error("bootstrapChatRuntime requires uplinks");
  }
  const ownerAccountId = String(identity.accountId || "").trim();
  const publicKeyB64 = String(identity.publicKeyB64 || "").trim();
  const hasAdminRoot = identity.hasAdminRoot !== false;
  const privateKeyB64 = hasAdminRoot ? String(identity.privateKeyB64 || "").trim() : "";
  if (!ownerAccountId || !publicKeyB64 || (hasAdminRoot && !privateKeyB64)) {
    throw new Error("bootstrapChatRuntime identity is incomplete");
  }
  if (!hasAdminRoot && (!deviceKey || !deviceKey.deviceKeyPair || !deviceKey.deviceId)) {
    throw new Error("bootstrapChatRuntime delegated identity requires the persisted device key");
  }
  if (!hasAdminRoot && (!Array.isArray(identity.certChain) || identity.certChain.length === 0)) {
    throw new Error("bootstrapChatRuntime delegated identity requires certChain");
  }

  const inboxClaimant = await InboxClaimant.bootstrap({
    storageProvider,
    cryptoProvider,
    identity: hasAdminRoot
      ? { publicKeyB64, privateKeyB64 }
      : {
          publicKeyB64: deviceKey.deviceKeyPair.publicKeyB64,
          privateKeyB64: deviceKey.deviceKeyPair.privateKeyB64,
        },
    delegatedInboxId: !hasAdminRoot && typeof identity.inboxId === "string" ? identity.inboxId : null,
  });

  const inviteAuthority = buildChatServerInviteAuthority({
    accountId: ownerAccountId,
    identity: { publicKeyB64, privateKeyB64 },
    cryptoProvider,
    hasAdminRoot,
  });
  const peerLinkService = new PeerLinkService({
    storageProvider,
    clock: () => Date.now(),
    ownerAccountId,
    signer: inviteAuthority.signer,
    verifier: inviteAuthority.verifier,
    inviteBinding: { mailboxId: inboxClaimant.inboxId, capabilityId: inboxClaimant.inboxId },
    cryptoProvider,
    inboxClaimantSigner: inboxClaimant.createCapabilitySigner(),
    deviceKeyPair: deviceKey && deviceKey.deviceKeyPair ? deviceKey.deviceKeyPair : null,
    deviceId: deviceKey && deviceKey.deviceId ? deviceKey.deviceId : null,
    accountIdentityDhKeyPair: identity.accountIdentityDhKeyPair || null,
    allowLegacyAccountIdentityDhAdoption: allowLegacyAccountIdentityDhAdoption === true,
    accountCapabilityCertChain: hasAdminRoot ? null : identity.certChain,
    hasAdminRoot,
  });

  await selfProvisionAccountBinding({
    peerLinkService,
    identity: { accountId: ownerAccountId, publicKeyB64, privateKeyB64 },
    cryptoProvider,
    hasAdminRoot,
  });

  const adoptedLegacyAccountIdentityDhKeyPair = peerLinkService.getAdoptedLegacyAccountIdentityDhKeyPair();
  if (adoptedLegacyAccountIdentityDhKeyPair) {
    if (hasAdminRoot !== true || typeof onLegacyAccountIdentityDhAdopted !== "function") {
      const err = new Error("chat runtime cannot persist the validated legacy account identity-DH key");
      err.code = "ACCOUNT_IDENTITY_DH_MIGRATION_PERSISTENCE_REQUIRED";
      throw err;
    }
    await onLegacyAccountIdentityDhAdopted({
      ownerAccountId,
      accountIdentityDhKeyPair: adoptedLegacyAccountIdentityDhKeyPair,
    });
  }
  const effectiveAccountIdentityDhKeyPair = adoptedLegacyAccountIdentityDhKeyPair
    || identity.accountIdentityDhKeyPair
    || null;

  const clientIdentity = {
    accountId: ownerAccountId,
    deviceId: deviceKey && deviceKey.deviceId ? deviceKey.deviceId : String(identity.deviceId || "").trim(),
    publicKeyB64,
    privateKeyB64: hasAdminRoot ? privateKeyB64 : null,
    deviceKey: deviceKey && deviceKey.deviceKeyPair ? deviceKey.deviceKeyPair : null,
  };
  if (!hasAdminRoot) {
    clientIdentity.certChain = identity.certChain;
  }
  const chatServer = new ChatServerApp({
    identity: clientIdentity,
    uplinks,
    storageProvider,
    ownerAccountId,
    peerLinkService,
    inboxClaimant,
    expectedNodePublicKeyB64,
    accountAuthority: inviteAuthority,
    accountIdentityDhKeyPair: effectiveAccountIdentityDhKeyPair,
    wsFactory,
    linksServiceFactory,
    deviceLinkServiceFactory,
    logger,
  });

  return {
    chatServer,
    ownerAccountId,
    identity,
    storageProvider,
    peerLinkService,
    inboxClaimant,
  };
}
