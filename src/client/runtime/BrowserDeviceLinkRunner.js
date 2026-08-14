import {
  BrowserCryptoProvider,
  bytesToBase64,
  createRezClient,
  deriveAccountIdFromPublicKey,
  deriveDeviceIdFromPublicKeyB64,
} from "@rezprotocol/sdk/client";
import { runDeviceLinkRequester as runSdkRequester } from "@rezprotocol/sdk/device-link";

/**
 * Bind hosted-runtime dependencies without narrowing the requester contract.
 * Persistence is part of the ceremony's safety boundary: the new device must
 * durably store its delegation before it confirms possession to the primary.
 */
export function createBrowserDeviceLinkRunner({
  uplinks,
  logger = console,
  runner = runBrowserDeviceLinkRequester,
} = {}) {
  if (!Array.isArray(uplinks) || uplinks.length === 0) {
    throw new Error("createBrowserDeviceLinkRunner requires uplinks");
  }
  if (typeof runner !== "function") {
    throw new Error("createBrowserDeviceLinkRunner requires runner");
  }
  return ({ linkCode, persistDelegation = null, onStatus = null } = {}) => runner({
    linkCode,
    uplinks,
    logger,
    persistDelegation,
    onStatus,
  });
}

/**
 * Run the NEW-device half of the link ceremony before a browser account exists.
 *
 * The temporary SDK identity is used only to reach the account-blind durable
 * rendezvous. The actual device key is minted inside the SDK requester and
 * never leaves this browser; the returned delegation is persisted by the
 * browser auth service before the normal delegated runtime boots.
 */
export async function runBrowserDeviceLinkRequester({
  linkCode,
  uplinks,
  timeoutMs = 180_000,
  logger = console,
  cryptoProvider = null,
  sdkFactory = createRezClient,
  requester = runSdkRequester,
  wsFactory = null,
  onStatus = null,
  persistDelegation = null,
} = {}) {
  const code = typeof linkCode === "string" ? linkCode.trim() : "";
  if (!code) throw new Error("runBrowserDeviceLinkRequester requires linkCode");
  if (!Array.isArray(uplinks) || uplinks.length === 0) {
    throw new Error("runBrowserDeviceLinkRequester requires uplinks");
  }
  const crypto = cryptoProvider || new BrowserCryptoProvider();
  const session = await crypto.generateSigningKeyPair();
  const sessionPubB64 = bytesToBase64(session.publicKey);
  const sessionDeviceId = deriveDeviceIdFromPublicKeyB64(sessionPubB64);
  const resolvedWsFactory = typeof wsFactory === "function"
    ? wsFactory
    : (url) => new globalThis.WebSocket(url);
  const sdk = sdkFactory({
    identity: {
      accountId: deriveAccountIdFromPublicKey(session.publicKey),
      deviceId: sessionDeviceId,
      publicKeyB64: sessionPubB64,
      privateKeyB64: bytesToBase64(session.privateKey),
    },
    uplinks,
    clientVersion: "rez-chat-browser-device-link/1.0",
    wsFactory: resolvedWsFactory,
  });
  if (!sdk || typeof sdk.connect !== "function" || typeof sdk.close !== "function"
    || !sdk.durableRecords) {
    throw new Error("runBrowserDeviceLinkRequester SDK factory returned an invalid client");
  }
  try {
    await sdk.connect();
    return await requester({
      code,
      crypto,
      records: sdk.durableRecords,
      deadlineMs: timeoutMs,
      onStatus,
      persistDelegation,
    });
  } finally {
    try {
      await sdk.close();
    } catch (err) {
      if (logger && typeof logger.warn === "function") {
        logger.warn("[device-link] temporary browser client close failed", err && err.message ? err.message : err);
      }
    }
  }
}
