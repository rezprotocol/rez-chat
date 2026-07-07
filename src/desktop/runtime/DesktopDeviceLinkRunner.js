import { WebSocket } from "ws";
import { NodeCryptoProvider } from "@rezprotocol/node";
import {
  createRezClient,
  bytesToBase64,
  deriveAccountIdFromPublicKey,
} from "@rezprotocol/sdk/client";
import { runDeviceLinkRequester as runSdkRequester } from "@rezprotocol/sdk/device-link";

/**
 * The NEW-device ceremony runner (S2.5 S10 C3). Pre-login the desktop app
 * already runs its local node (startShellServer boots node + shell before any
 * unlock), so the requester rides a TEMPORARY SDK client against that node:
 * a throwaway session identity (any self-generated key can session-auth —
 * the protocol is account-blind), durable-record put/get for the ceremony
 * slots, closed in finally. Returns the SDK requester's result verbatim:
 * `{ delegation, deviceId, fingerprint }` — the vault provisions from it.
 */
export async function runDeviceLinkRequester({
  linkCode,
  wsUrl,
  expectedNodePublicKeyB64 = "",
  timeoutMs = 180_000,
  logger = console,
} = {}) {
  if (typeof linkCode !== "string" || linkCode.trim().length === 0) {
    throw new Error("runDeviceLinkRequester requires linkCode");
  }
  if (typeof wsUrl !== "string" || wsUrl.trim().length === 0) {
    throw new Error("runDeviceLinkRequester requires wsUrl (the local node)");
  }
  const cryptoProvider = new NodeCryptoProvider();
  const session = cryptoProvider.generateSigningKeyPair();
  const sdk = createRezClient({
    identity: {
      accountId: deriveAccountIdFromPublicKey(session.publicKey),
      publicKeyB64: bytesToBase64(session.publicKey),
      privateKeyB64: bytesToBase64(session.privateKey),
    },
    uplinks: [wsUrl],
    clientVersion: "rez-chat-device-link/1.0",
    wsFactory: (url) => new WebSocket(url),
    expectedNodePublicKeyB64: typeof expectedNodePublicKeyB64 === "string" ? expectedNodePublicKeyB64.trim() : "",
  });
  try {
    await sdk.connect();
    return await runSdkRequester({
      code: linkCode.trim(),
      crypto: cryptoProvider,
      records: sdk.durableRecords,
      deadlineMs: timeoutMs,
    });
  } finally {
    try {
      await sdk.close();
    } catch (err) {
      logger.warn("[device-link] temporary client close failed", err && err.message ? err.message : err);
    }
  }
}
