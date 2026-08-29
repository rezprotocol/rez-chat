import {
  BrowserCryptoProvider,
  IndexedDbStorageProvider,
  base64ToBytes,
} from "@rezprotocol/sdk/client";
import { bootstrapChatRuntime } from "../../server/bootstrap/bootstrapChatRuntime.js";
import { mapUnlockedAccountToRuntimeIdentity } from "../../server/bootstrap/unlockedAccountIdentity.js";
import { browserChatRuntimeDbName } from "./browserRuntimeStorage.js";

export { browserChatRuntimeDbName } from "./browserRuntimeStorage.js";

export async function bootstrapBrowserChatRuntime({ account, uplinks, logger = console } = {}) {
  if (!account || typeof account !== "object") {
    throw new Error("bootstrapBrowserChatRuntime requires unlocked account");
  }
  if (!Array.isArray(uplinks) || uplinks.length === 0) {
    throw new Error("bootstrapBrowserChatRuntime requires uplinks");
  }
  // P1.3c SSOT: the unlock-result → runtime identity/deviceKey projection is
  // shared with the mobile boot mapper. The browser topology boots the
  // LEGACY inbox role (the delegated ceremony inbox IS its runtime primary),
  // which is bootstrapChatRuntime's default — the mapping itself is
  // role-free.
  const { hasAdminRoot, identity, deviceKey } = mapUnlockedAccountToRuntimeIdentity(account);
  const storagePrivateKeyB64 = hasAdminRoot
    ? identity.privateKeyB64
    : deviceKey.deviceKeyPair.privateKeyB64;
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
    identity,
    deviceKey,
    storageProvider,
    cryptoProvider,
    uplinks,
    wsFactory: (url) => new globalThis.WebSocket(url),
    logger,
  });
}
