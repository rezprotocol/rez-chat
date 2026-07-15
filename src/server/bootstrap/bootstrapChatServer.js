import path from "node:path";
import { FsStorageProvider, NodeCryptoProvider } from "@rezprotocol/node";
import { base64ToBytes, bytesToBase64, canonicalJSONStringify, deriveAccountIdFromPublicKey } from "@rezprotocol/sdk/client";
import { PeerLinkService } from "@rezprotocol/sdk/peer-link";
import { ensureChatServerIdentity } from "../identity/ChatServerIdentity.js";
import { ChatServerApp } from "../app/index.js";
import { InboxClaimant } from "../inbox/InboxClaimant.js";

/**
 * Builds the chat-server invite signer/verifier pair backed by the chat-server's
 * persistent account-identity keypair.
 *
 * Invite envelopes embed `signerPublicKeyB64` in their signerRef so a remote
 * acceptor can verify against that pubkey — no shared key registry, no
 * per-boot ephemerals, no symmetric trust between chat-servers. The verifier
 * also cross-checks that the embedded pubkey derives to the envelope's
 * declared `creatorAccountId`, so a forged envelope can't impersonate another
 * account while keeping the sig valid.
 *
 * The signing key is the chat-server's identity key (same key that
 * authenticates the WS session and claims the inbox), giving a single root
 * of trust per chat-server. Multi-device invite signing later can layer a
 * delegation cap on top without changing this surface.
 */
export function buildChatServerInviteAuthority({ accountId, identity, cryptoProvider, hasAdminRoot = true }) {
  const keyId = "invite-ed25519-v1";
  const alg = "ed25519";
  // S9 delegated mode: a seedless device holds NO account private key. The
  // verifier and signerRef are pub-only and identical in both modes; the SIGN
  // function THROWS so any residual account-sign consumer (group consent,
  // future callers) fails loud instead of silently missigning — the delegated
  // paths sign with the device key C inside PeerLinkService, never here.
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
        if (!refAccountId) return false;
        const refPubB64 = String((signerRef && signerRef.signerPublicKeyB64) || "");
        if (!refPubB64) return false;
        let refPub;
        try {
          refPub = base64ToBytes(refPubB64);
        } catch {
          return false;
        }
        // Tie the embedded pubkey to the declared accountId so a valid sig
        // can't be forged under someone else's accountId.
        let derived;
        try {
          derived = deriveAccountIdFromPublicKey(refPub);
        } catch {
          return false;
        }
        if (derived !== refAccountId) return false;
        // Verifier accepts any chat-server's invite as long as the embedded
        // pubkey signed the envelope. Same-account loopback (own invite
        // verifying locally) is just a special case of the same check.
        if (refAccountId === accountId) {
          return cryptoProvider.verify({ publicKey, msg: bytes, sig: sigBytes });
        }
        return cryptoProvider.verify({ publicKey: refPub, msg: bytes, sig: sigBytes });
      },
    },
  };
}

/**
 * Binds chat-server's PeerLinkService X3DH identity to its account identity by
 * having the account key sign an "x3dh-subkey-binding" payload over the X3DH
 * pubkey. Chat-server owns both keys (Shape A), so this is a synchronous
 * self-sign; no node ceremony needed.
 */
export async function selfProvisionAccountBinding({ peerLinkService, identity, cryptoProvider, hasAdminRoot = true }) {
  // S9 delegated mode: the device holds no account key to self-sign with —
  // the SDK produces the C-signed binding (the S8 dual-mode verifier accepts
  // it via the cert chain riding in the invite envelope).
  if (!hasAdminRoot) {
    await peerLinkService.selfProvisionDelegatedAccountBinding({ ownerAccountId: identity.accountId });
    return;
  }
  const challenge = await peerLinkService.getOrCreateAccountBindingChallenge({
    ownerAccountId: identity.accountId,
  });
  const x3dhIdentityPublicKeyB64 = String(challenge && challenge.x3dhIdentityPublicKeyB64 || "").trim();
  if (!x3dhIdentityPublicKeyB64) {
    throw new Error("chat-server PeerLinkService did not yield an X3DH identity");
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
  const sig = cryptoProvider.sign({
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

/**
 * Bootstraps a ChatServerApp on top of an already-running node.
 *
 * Constructs chat-server's own identity + encrypted storage + PeerLinkService,
 * self-signs the account/X3DH binding, then wires a ChatServerApp pointed at
 * the provided wsUrl. The returned ChatServerApp has NOT been started yet —
 * caller invokes `.start()`.
 *
 * `nodeDataDir` is the root of the node's data directory; chat-server's
 * storage lives at `<nodeDataDir>/chat-server`. This mirrors `startRezChat`'s
 * production layout — chat-server's bytes are encrypted with a key derived
 * from chat-server's OWN private key, so a future hosted-node operator with
 * disk access to the node dir cannot decrypt them (Shape A).
 */
export async function bootstrapChatServer({
  nodeDataDir,
  wsUrl,
  expectedNodePublicKeyB64 = "",
  logger = console,
  expectedChatServerIdentity = null,
  deviceKey = null,
  allowChatServerIdentityRotation = false,
} = {}) {
  if (typeof nodeDataDir !== "string" || nodeDataDir.trim().length === 0) {
    throw new Error("bootstrapChatServer requires nodeDataDir");
  }
  if (typeof wsUrl !== "string" || wsUrl.trim().length === 0) {
    throw new Error("bootstrapChatServer requires wsUrl");
  }

  // S9: one mode switch for the whole bootstrap. An identity stamped
  // hasAdminRoot=false is a DELEGATED (seedless) device — the account key B
  // exists here as a PUBLIC key only; the device key C is the only signer.
  const hasAdminRoot = !(expectedChatServerIdentity && expectedChatServerIdentity.hasAdminRoot === false);
  if (!hasAdminRoot) {
    if (!deviceKey || !deviceKey.deviceKeyPair || !deviceKey.deviceKeyPair.publicKeyB64
      || !deviceKey.deviceKeyPair.privateKeyB64 || !deviceKey.deviceId) {
      throw new Error("bootstrapChatServer: a delegated chat-server identity requires deviceKey (the device key C is its only signer)");
    }
    if (!Array.isArray(expectedChatServerIdentity.certChain) || expectedChatServerIdentity.certChain.length === 0) {
      throw new Error("bootstrapChatServer: a delegated chat-server identity requires a non-empty certChain");
    }
  }

  const cryptoProvider = new NodeCryptoProvider();
  const chatStorageDir = path.join(nodeDataDir, "chat-server");
  const bootstrapProvider = new FsStorageProvider({ rootDir: chatStorageDir });
  const identity = await ensureChatServerIdentity({
    storageProvider: bootstrapProvider,
    cryptoProvider,
    // A delegated row persists the self-certifying deviceId of C.
    expectedIdentity: hasAdminRoot
      ? expectedChatServerIdentity
      : { ...expectedChatServerIdentity, deviceId: deviceKey.deviceId },
    allowOverwrite: allowChatServerIdentityRotation,
  });
  const ownerAccountId = identity.accountId;

  // Storage at-rest key: rooted in the account key on a primary (unchanged),
  // in the DEVICE key on a delegated device — with a DISTINCT salt label
  // (never reuse a derivation label across key domains).
  let storageEncKey;
  if (hasAdminRoot) {
    const privateKeyBytes = base64ToBytes(identity.privateKeyB64);
    storageEncKey = cryptoProvider.hkdfSha256(privateKeyBytes, {
      salt: new TextEncoder().encode("rez:chat-server:storage:v1"),
      info: new TextEncoder().encode("rez:chat-server:kv:aes256gcm"),
      length: 32,
    });
  } else {
    storageEncKey = cryptoProvider.hkdfSha256(base64ToBytes(deviceKey.deviceKeyPair.privateKeyB64), {
      salt: new TextEncoder().encode("rez:chat-server:storage:delegated:v1"),
      info: new TextEncoder().encode("rez:chat-server:kv:aes256gcm"),
      length: 32,
    });
  }
  const storageProvider = new FsStorageProvider({
    rootDir: chatStorageDir,
    encryptionKey: storageEncKey,
  });

  // Persistent inbox claim — chat-server claims a stable inboxId on first boot
  // and binds it to the chat-server's identity keypair. Same keypair
  // authenticates the WS session AND signs claim/cap delegations, so the relay
  // sees one identity instead of two; the deposit-broadcast lookup
  // (sessionRegistry keyed by pubkey) and the inbox registry
  // (HostedInboxRegistry keyed by claimant pubkey) align without translation.
  const inboxClaimant = await InboxClaimant.bootstrap({
    storageProvider,
    cryptoProvider,
    // Delegated: the device key C claims the inbox (deterministic, keystore-
    // persisted). The claimant is deliberately NOT the account identity —
    // claimant/account unlinkability is the standing blindness primitive — so
    // keying it on C changes nothing the node can see.
    identity: hasAdminRoot
      ? {
          publicKeyB64: identity.publicKeyB64,
          privateKeyB64: identity.privateKeyB64,
        }
      : {
          publicKeyB64: deviceKey.deviceKeyPair.publicKeyB64,
          privateKeyB64: deviceKey.deviceKeyPair.privateKeyB64,
        },
    // P1#2 L3.5: for a delegated (device-linked) chat server, claim the EXACT inbox the
    // device-link ceremony pre-registered (device.add), persisted in the delegated keystore
    // and surfaced on the identity — never a freshly-minted one. Primary/legacy (no inbox) →
    // null → the unchanged fresh-claim path.
    delegatedInboxId: !hasAdminRoot && expectedChatServerIdentity && typeof expectedChatServerIdentity.inboxId === "string"
      ? expectedChatServerIdentity.inboxId
      : null,
  });

  const inviteAuthority = buildChatServerInviteAuthority({
    accountId: ownerAccountId,
    identity,
    cryptoProvider,
    hasAdminRoot,
  });
  const peerLinkService = new PeerLinkService({
    storageProvider,
    clock: () => Date.now(),
    ownerAccountId,
    signer: inviteAuthority.signer,
    verifier: inviteAuthority.verifier,
    // SSOT for the invite reply binding: every invite this chat-server creates
    // must route the acceptor's handshake back to our PERSISTENT claimed inbox
    // (the cap chain anchors on it), NOT the SDK session's ephemeral inbox. Wire
    // it ONCE here so createInvite is always correctly bound regardless of caller
    // — user invites (ServerInvitesService) and automated recovery re-invites
    // (ServerPeerLinkProtocolService) both inherit it. Previously this was null
    // and every call site had to remember `peerInboxId`; the recovery path forgot
    // and silently produced bindingless invites (acceptInvite → degraded).
    inviteBinding: { mailboxId: inboxClaimant.inboxId, capabilityId: inboxClaimant.inboxId },
    cryptoProvider,
    inboxClaimantSigner: inboxClaimant.createCapabilitySigner(),
    // S2.5 per-device E2EE: this device's key (C), rooted in the chat-server
    // identity B. When present, PeerLinkService can run per-device sessions; the
    // E6 fan-out gate keeps the default send path single-device until Slice 8.
    // Absent (legacy/web vault) ⇒ legacy single-device path, unchanged.
    deviceKeyPair: deviceKey && deviceKey.deviceKeyPair ? deviceKey.deviceKeyPair : null,
    deviceId: deviceKey && deviceKey.deviceId ? deviceKey.deviceId : null,
    // Audit P1: the SEED-DERIVED account identity-DH key (X25519), shared across
    // every device of this account, so a peer's sealed device set is openable on
    // all of them. Sourced from the raw chat-server identity (ensureChatServerIdentity
    // strips it). Null on a pre-migration vault ⇒ legacy device-local random key.
    accountIdentityDhKeyPair: expectedChatServerIdentity && expectedChatServerIdentity.accountIdentityDhKeyPair
      ? expectedChatServerIdentity.accountIdentityDhKeyPair
      : null,
    // S9: cert-mode invite/device-set signing on a delegated device. The chain
    // is vault-supplied at every boot (never persisted chat-server-side);
    // hasAdminRoot is passed EXPLICITLY so a contradiction between the flag
    // and the material fails loud in the PeerLinkService constructor.
    accountCapabilityCertChain: hasAdminRoot ? null : expectedChatServerIdentity.certChain,
    hasAdminRoot,
  });

  await selfProvisionAccountBinding({
    peerLinkService,
    identity,
    cryptoProvider,
    hasAdminRoot,
  });

  const chatServer = new ChatServerApp({
    identity: {
      accountId: identity.accountId,
      // S2.5 Slice 5: when a device key (C) is present, the SDK session
      // authenticates AS the SIGNED self-certifying deviceId (rez:dev:sha256),
      // and `device.bind` keys the durable home cursor on it. Absent (legacy /
      // web vault) ⇒ the persistent chat-server deviceId, unchanged. The wire
      // SessionHello.deviceId is set from this field (AuthStateMachine).
      deviceId: deviceKey && deviceKey.deviceId ? deviceKey.deviceId : identity.deviceId,
      publicKeyB64: identity.publicKeyB64,
      // Delegated: NO account private key exists — the SDK's AuthStateMachine
      // signs the session challenge with C and attaches the chain (S7).
      privateKeyB64: hasAdminRoot ? identity.privateKeyB64 : null,
      // The device keypair (C) so the SDK's IdentityCapability can build the
      // device-signed DeviceInboxBindingV1 + account-signed DeviceRegistrationV1
      // for `device.bind`. Null on a legacy keystore.
      deviceKey: deviceKey && deviceKey.deviceKeyPair ? deviceKey.deviceKeyPair : null,
      ...(hasAdminRoot ? {} : { certChain: expectedChatServerIdentity.certChain }),
    },
    uplinks: [wsUrl],
    storageProvider,
    ownerAccountId,
    peerLinkService,
    inboxClaimant,
    expectedNodePublicKeyB64,
    // REZ-2: same account-key authority used for invite envelopes, reused to
    // sign + verify group membership-consent proofs.
    accountAuthority: inviteAuthority,
    // S10: B-dh for the device-link approver (the delegation bundle ships the
    // PAIR). Same source as the PeerLinkService wiring above; null on a
    // pre-migration vault (deviceLink.start then fails loud).
    accountIdentityDhKeyPair: expectedChatServerIdentity && expectedChatServerIdentity.accountIdentityDhKeyPair
      ? expectedChatServerIdentity.accountIdentityDhKeyPair
      : null,
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
