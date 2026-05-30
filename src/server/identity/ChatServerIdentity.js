import { randomBytes } from "node:crypto";
import { Identity, bytesToBase64 } from "@rezprotocol/sdk/client";
import { StoredServerIdentity } from "../../records/domain/StoredServerIdentity.js";

const STORE_KEY = "chat-server:identity:v1";

/**
 * Loads chat-server's account-level identity from its own storage, or generates
 * and persists one on first boot.
 *
 * This is the chat-server (user/account) identity. It is NOT the node identity.
 * In Shape A (see docs/HOSTED_NODE_DESIGN.md §1) the node operator must never
 * see chat-server's private key — it lives only in chat-server's storage on
 * the user's device. The node has its own separate keypair (managed by
 * ensureNodeIdentity in rez-node) used for routing/network roles.
 *
 * Today the gate forces loopback so both private keys live on the same
 * machine, but the data-split structure here matches the eventual hosted
 * deployment: chat-server's identity does not flow into anything node-side.
 */
export async function ensureChatServerIdentity({ storageProvider, cryptoProvider } = {}) {
  if (!storageProvider || typeof storageProvider.getKeyValueStore !== "function") {
    throw new Error("ensureChatServerIdentity requires storageProvider");
  }
  if (!cryptoProvider) {
    throw new Error("ensureChatServerIdentity requires cryptoProvider");
  }
  const kv = storageProvider.getKeyValueStore(null);
  const stored = await kv.get(STORE_KEY);
  if (stored && typeof stored === "object" && !Array.isArray(stored)) {
    // KV-deserialization boundary: tolerate corrupt blobs and regenerate.
    try {
      return new StoredServerIdentity(stored);
    } catch {
      // fall through to regeneration
    }
  }

  const identity = await Identity.generate({ cryptoProvider });
  const record = new StoredServerIdentity({
    accountId: identity.getAccountId(),
    deviceId: `dev:${randomBytes(8).toString("hex")}`,
    publicKeyB64: bytesToBase64(identity.getPublicKeyBytes()),
    privateKeyB64: bytesToBase64(identity.getPrivateKeyBytes()),
  });
  await kv.set(STORE_KEY, record.toJSON());
  return record;
}
