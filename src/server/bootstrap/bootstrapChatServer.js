import path from "node:path";
import { FsStorageProvider, NodeCryptoProvider } from "@rezprotocol/node";
import { WebSocket } from "ws";
import { base64ToBytes } from "@rezprotocol/sdk/client";
import { ensureChatServerIdentity } from "../identity/ChatServerIdentity.js";
import { ServerLinksService } from "../services/ServerLinksService.js";
import { ServerDeviceLinkService } from "../services/ServerDeviceLinkService.js";
import { LinkPreviewStore } from "../storage/LinkPreviewStore.js";
import {
  bootstrapChatRuntime,
  buildChatServerInviteAuthority,
  selfProvisionAccountBinding,
} from "./bootstrapChatRuntime.js";

export { buildChatServerInviteAuthority, selfProvisionAccountBinding };

/**
 * Node/desktop adapter for the platform-neutral chat runtime.
 *
 * Filesystem storage, Node crypto, the `ws` implementation, and the hardened
 * server-side link-preview fetcher are selected here. Browser clients use the
 * same bootstrapChatRuntime composition with IndexedDB, WebCrypto, and the
 * browser WebSocket implementation.
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
    expectedIdentity: hasAdminRoot
      ? expectedChatServerIdentity
      : { ...expectedChatServerIdentity, deviceId: deviceKey.deviceId },
    allowOverwrite: allowChatServerIdentityRotation,
  });

  const storageKeyMaterial = hasAdminRoot
    ? base64ToBytes(identity.privateKeyB64)
    : base64ToBytes(deviceKey.deviceKeyPair.privateKeyB64);
  const storageEncKey = await cryptoProvider.hkdfSha256(storageKeyMaterial, {
    salt: new TextEncoder().encode(
      hasAdminRoot ? "rez:chat-server:storage:v1" : "rez:chat-server:storage:delegated:v1",
    ),
    info: new TextEncoder().encode("rez:chat-server:kv:aes256gcm"),
    length: 32,
  });
  const storageProvider = new FsStorageProvider({
    rootDir: chatStorageDir,
    encryptionKey: storageEncKey,
  });

  const runtimeIdentity = {
    accountId: identity.accountId,
    deviceId: identity.deviceId,
    publicKeyB64: identity.publicKeyB64,
    privateKeyB64: hasAdminRoot ? identity.privateKeyB64 : "",
    hasAdminRoot,
    accountIdentityDhKeyPair: expectedChatServerIdentity && expectedChatServerIdentity.accountIdentityDhKeyPair
      ? expectedChatServerIdentity.accountIdentityDhKeyPair
      : null,
    certChain: hasAdminRoot ? null : expectedChatServerIdentity.certChain,
    inboxId: !hasAdminRoot && typeof expectedChatServerIdentity.inboxId === "string"
      ? expectedChatServerIdentity.inboxId
      : null,
  };
  const bootstrapped = await bootstrapChatRuntime({
    identity: runtimeIdentity,
    deviceKey,
    storageProvider,
    cryptoProvider,
    uplinks: [wsUrl],
    expectedNodePublicKeyB64,
    wsFactory: (url) => new WebSocket(url),
    linksServiceFactory: ({ bus, storageProvider: provider, ownerAccountId, clock, logger: serviceLogger }) => (
      new ServerLinksService({
        bus,
        linkPreviewStore: new LinkPreviewStore({ storageProvider: provider, clock }),
        ownerAccountId,
        clock,
        logger: serviceLogger,
      })
    ),
    deviceLinkServiceFactory: ({ bus, storageProvider: provider, ownerAccountId, clock, logger: serviceLogger }) => (
      new ServerDeviceLinkService({
        bus,
        ownerAccountId,
        storageProvider: provider,
        clock,
        logger: serviceLogger,
      })
    ),
    logger,
  });
  return { ...bootstrapped, identity };
}
