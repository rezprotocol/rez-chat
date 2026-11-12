import path from "node:path";
import { FsStorageProvider, NodeCryptoProvider } from "@rezprotocol/node";
import { Identity, bytesToBase64 } from "@rezprotocol/sdk/client";
import { StoredServerIdentity } from "../../src/records/domain/StoredServerIdentity.js";
import { bootstrapChatServer } from "../../src/server/index.js";

// Synthetic test accounts need a vault owner too. Keep fixture credentials
// outside chat-server storage and preserve them across the restart scenarios.
// Production callers always supply the real unlocked vault identity.
export async function bootstrapTestChatServer(options) {
  if (options.expectedChatServerIdentity) return bootstrapChatServer(options);
  const vault = new FsStorageProvider({ rootDir: path.join(options.nodeDataDir, "test-vault") }).getKeyValueStore(null);
  const stored = await vault.getStrict("identity");
  let identity;
  if (stored !== undefined) {
    identity = new StoredServerIdentity(stored);
  } else {
    const account = await Identity.generate({ cryptoProvider: new NodeCryptoProvider() });
    identity = new StoredServerIdentity({
      accountId: account.getAccountId(),
      deviceId: "dev:test-vault",
      publicKeyB64: bytesToBase64(account.getPublicKeyBytes()),
      privateKeyB64: bytesToBase64(account.getPrivateKeyBytes()),
    });
    await vault.set("identity", identity.toJSON());
  }
  return bootstrapChatServer({ ...options, expectedChatServerIdentity: identity });
}
