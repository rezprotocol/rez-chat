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
export function buildChatServerInviteAuthority({ accountId, identity, cryptoProvider }) {
  const keyId = "invite-ed25519-v1";
  const alg = "ed25519";
  const privateKey = base64ToBytes(identity.privateKeyB64);
  const publicKey = base64ToBytes(identity.publicKeyB64);
  const signerPublicKeyB64 = identity.publicKeyB64;
  return {
    signer: {
      getSignerRef() {
        return { accountId, keyId, alg, signerPublicKeyB64 };
      },
      async sign(bytes) {
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
export async function selfProvisionAccountBinding({ peerLinkService, identity, cryptoProvider }) {
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
export async function bootstrapChatServer({ nodeDataDir, wsUrl, expectedNodePublicKeyB64 = "", logger = console } = {}) {
  if (typeof nodeDataDir !== "string" || nodeDataDir.trim().length === 0) {
    throw new Error("bootstrapChatServer requires nodeDataDir");
  }
  if (typeof wsUrl !== "string" || wsUrl.trim().length === 0) {
    throw new Error("bootstrapChatServer requires wsUrl");
  }

  const cryptoProvider = new NodeCryptoProvider();
  const chatStorageDir = path.join(nodeDataDir, "chat-server");
  const bootstrapProvider = new FsStorageProvider({ rootDir: chatStorageDir });
  const identity = await ensureChatServerIdentity({
    storageProvider: bootstrapProvider,
    cryptoProvider,
  });
  const ownerAccountId = identity.accountId;

  const privateKeyBytes = base64ToBytes(identity.privateKeyB64);
  const storageEncKey = cryptoProvider.hkdfSha256(privateKeyBytes, {
    salt: new TextEncoder().encode("rez:chat-server:storage:v1"),
    info: new TextEncoder().encode("rez:chat-server:kv:aes256gcm"),
    length: 32,
  });
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
    identity: {
      publicKeyB64: identity.publicKeyB64,
      privateKeyB64: identity.privateKeyB64,
    },
  });

  const inviteAuthority = buildChatServerInviteAuthority({
    accountId: ownerAccountId,
    identity,
    cryptoProvider,
  });
  const peerLinkService = new PeerLinkService({
    storageProvider,
    clock: () => Date.now(),
    ownerAccountId,
    signer: inviteAuthority.signer,
    verifier: inviteAuthority.verifier,
    inviteBinding: null,
    cryptoProvider,
    inboxClaimantSigner: inboxClaimant.createCapabilitySigner(),
  });

  await selfProvisionAccountBinding({
    peerLinkService,
    identity,
    cryptoProvider,
  });

  const chatServer = new ChatServerApp({
    identity: {
      accountId: identity.accountId,
      deviceId: identity.deviceId,
      publicKeyB64: identity.publicKeyB64,
      privateKeyB64: identity.privateKeyB64,
    },
    uplinks: [wsUrl],
    storageProvider,
    ownerAccountId,
    peerLinkService,
    inboxClaimant,
    expectedNodePublicKeyB64,
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
