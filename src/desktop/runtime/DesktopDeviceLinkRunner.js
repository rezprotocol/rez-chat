import { WebSocket } from "ws";
import { NodeCryptoProvider } from "@rezprotocol/node";
import { runDeviceLinkRequester as runSharedDeviceLinkRequester } from "../../client/runtime/DeviceLinkRunner.js";

// Desktop contributes only its platform primitives. The requester ceremony,
// temporary identity, persistence ordering and cleanup have one shared owner.
export function runDeviceLinkRequester({
  linkCode,
  wsUrl,
  expectedNodePublicKeyB64 = "",
  timeoutMs = 180_000,
  logger = console,
  persistDelegation = null,
  onStatus = null,
} = {}) {
  if (typeof wsUrl !== "string" || wsUrl.trim().length === 0) {
    throw new Error("runDeviceLinkRequester requires wsUrl (the local node)");
  }
  return runSharedDeviceLinkRequester({
    linkCode,
    uplinks: [wsUrl.trim()],
    expectedNodePublicKeyB64,
    timeoutMs,
    logger,
    persistDelegation,
    onStatus,
    cryptoProvider: new NodeCryptoProvider(),
    wsFactory: (url) => new WebSocket(url),
  });
}
