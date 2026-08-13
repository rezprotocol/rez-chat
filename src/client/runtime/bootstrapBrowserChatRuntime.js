import {
  BrowserCryptoProvider,
  IndexedDbStorageProvider,
  base64ToBytes,
} from "@rezprotocol/sdk/client";
import { bootstrapChatRuntime } from "../../server/bootstrap/bootstrapChatRuntime.js";
import { browserChatRuntimeDbName } from "./browserRuntimeStorage.js";

export { browserChatRuntimeDbName } from "./browserRuntimeStorage.js";

export async function bootstrapBrowserChatRuntime({ account, uplinks, logger = console } = {}) {
  if (!account || typeof account !== "object") {
    throw new Error("bootstrapBrowserChatRuntime requires unlocked account");
  }
  if (!Array.isArray(uplinks) || uplinks.length === 0) {
    throw new Error("bootstrapBrowserChatRuntime requires uplinks");
  }
  const hasAdminRoot = account.hasAdminRoot !== false;
  const identityKeyPair = account.identityKeyPair && typeof account.identityKeyPair === "object"
    ? account.identityKeyPair
    : null;
  const deviceKeyPair = account.deviceKeyPair && typeof account.deviceKeyPair === "object"
    ? account.deviceKeyPair
    : null;
  if (!deviceKeyPair || !deviceKeyPair.publicKeyB64 || !deviceKeyPair.privateKeyB64) {
    throw new Error("bootstrapBrowserChatRuntime account is missing deviceKeyPair");
  }
  if (hasAdminRoot && (!identityKeyPair || !identityKeyPair.publicKeyB64 || !identityKeyPair.privateKeyB64)) {
    throw new Error("bootstrapBrowserChatRuntime primary account is missing identityKeyPair");
  }
  const publicKeyB64 = hasAdminRoot
    ? identityKeyPair.publicKeyB64
    : String(account.identityPublicKey || "").trim();
  const storagePrivateKeyB64 = hasAdminRoot
    ? identityKeyPair.privateKeyB64
    : deviceKeyPair.privateKeyB64;
  const cryptoProvider = new BrowserCryptoProvider();
  const storageEncKey = await cryptoProvider.hkdfSha256(base64ToBytes(storagePrivateKeyB64), {
    salt: new TextEncoder().encode(
      hasAdminRoot ? "rez:chat-server:storage:v1" : "rez:chat-server:storage:delegated:v1",
    ),
    info: new TextEncoder().encode("rez:chat-server:kv:aes256gcm"),
    length: 32,
  });
  const storageProvider = new IndexedDbStorageProvider({
    dbName: browserChatRuntimeDbName(account.accountId),
    storeName: "runtime",
    encryptionKey: storageEncKey,
    cryptoProvider,
  });
  return bootstrapChatRuntime({
    identity: {
      accountId: String(account.accountId || "").trim(),
      publicKeyB64,
      privateKeyB64: hasAdminRoot ? identityKeyPair.privateKeyB64 : "",
      hasAdminRoot,
      accountIdentityDhKeyPair: account.accountIdentityDhKeyPair || null,
      certChain: hasAdminRoot ? null : account.certChain,
      inboxId: hasAdminRoot ? null : account.inboxId,
    },
    deviceKey: {
      deviceId: String(account.deviceId || "").trim(),
      deviceKeyPair,
    },
    storageProvider,
    cryptoProvider,
    uplinks,
    wsFactory: (url) => new globalThis.WebSocket(url),
    logger,
  });
}
