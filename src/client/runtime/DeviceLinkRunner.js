import {
  BrowserCryptoProvider,
  bytesToBase64,
  createRezClient,
  deriveAccountIdFromPublicKey,
  deriveDeviceIdFromPublicKeyB64,
} from "@rezprotocol/sdk/client";
import { runDeviceLinkRequester as runSdkRequester } from "@rezprotocol/sdk/device-link";

export function createDeviceLinkRunner({
  uplinks,
  logger = console,
  cryptoProvider = null,
  wsFactory = null,
  expectedNodePublicKeyB64 = "",
  clock = () => Date.now(),
  runner = runDeviceLinkRequester,
} = {}) {
  if (!Array.isArray(uplinks) || uplinks.length === 0) throw new Error("createDeviceLinkRunner requires uplinks");
  if (typeof runner !== "function") throw new Error("createDeviceLinkRunner requires runner");
  return ({ linkCode, persistDelegation = null, onStatus = null } = {}) => runner({
    linkCode,
    uplinks,
    logger,
    cryptoProvider,
    wsFactory,
    expectedNodePublicKeyB64,
    clock,
    persistDelegation,
    onStatus,
  });
}

export async function runDeviceLinkRequester({
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
  expectedNodePublicKeyB64 = "",
  clock = () => Date.now(),
} = {}) {
  const code = typeof linkCode === "string" ? linkCode.trim() : "";
  if (!code) throw new Error("runDeviceLinkRequester requires linkCode");
  if (!Array.isArray(uplinks) || uplinks.length === 0) throw new Error("runDeviceLinkRequester requires uplinks");
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
    clientVersion: "rez-chat-device-link/1.0",
    wsFactory: resolvedWsFactory,
    expectedNodePublicKeyB64: typeof expectedNodePublicKeyB64 === "string" ? expectedNodePublicKeyB64.trim() : "",
  });
  if (!sdk || typeof sdk.connect !== "function" || typeof sdk.close !== "function" || !sdk.durableRecords) {
    throw new Error("runDeviceLinkRequester SDK factory returned an invalid client");
  }
  try {
    await sdk.connect();
    return await requester({
      code,
      crypto,
      records: sdk.durableRecords,
      deadlineMs: timeoutMs,
      nowMs: clock,
      onStatus,
      persistDelegation,
    });
  } finally {
    try {
      await sdk.close();
    } catch (err) {
      if (logger && typeof logger.warn === "function") {
        logger.warn("[device-link] temporary client close failed", err && err.message ? err.message : err);
      }
    }
  }
}
