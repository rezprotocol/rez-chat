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
/**
 * @param {object} options
 * @param {object} options.storageProvider
 * @param {object} options.cryptoProvider
 * @param {object} [options.expectedIdentity] - Optional pre-derived identity
 *     (e.g. BIP39-seed-derived from DesktopVaultService). If provided and no
 *     identity is stored yet, it's persisted as-is. If provided and a stored
 *     identity exists with a different pubkey, the call throws unless
 *     `allowOverwrite` is true (the once-per-account rotation case at first
 *     account-creation after a fresh boot).
 * @param {boolean} [options.allowOverwrite=false] - Replace any existing
 *     stored identity with `expectedIdentity` if they differ. Logged loudly.
 */
export async function ensureChatServerIdentity({
  storageProvider,
  cryptoProvider,
  expectedIdentity = null,
  allowOverwrite = false,
} = {}) {
  if (!storageProvider || typeof storageProvider.getKeyValueStore !== "function") {
    throw new Error("ensureChatServerIdentity requires storageProvider");
  }
  if (!cryptoProvider) {
    throw new Error("ensureChatServerIdentity requires cryptoProvider");
  }
  const kv = storageProvider.getKeyValueStore(null);
  const stored = await kv.get(STORE_KEY);
  let storedRecord = null;
  if (stored && typeof stored === "object" && !Array.isArray(stored)) {
    // KV-deserialization boundary: tolerate corrupt blobs and regenerate.
    try {
      storedRecord = new StoredServerIdentity(stored);
    } catch (err) {
      console.warn("[chat-server] stored identity blob is corrupt; regenerating", err && err.message ? err.message : err);
      storedRecord = null;
    }
  }

  if (storedRecord) {
    if (!expectedIdentity) return storedRecord;
    const expectedPub = String(expectedIdentity.publicKeyB64 || "").trim();
    if (!expectedPub) {
      throw new Error("ensureChatServerIdentity: expectedIdentity is missing publicKeyB64");
    }
    if (storedRecord.publicKeyB64 === expectedPub) {
      return storedRecord;
    }
    if (!allowOverwrite) {
      throw new Error(
        "ensureChatServerIdentity: stored chat-server identity does not match expectedIdentity "
        + "(stored=" + storedRecord.accountId + " expected=" + String(expectedIdentity.accountId || "?") + "). "
        + "Pass allowOverwrite=true to rotate.",
      );
    }
    console.warn("[chat-server] rotating identity from " + storedRecord.accountId
      + " to " + String(expectedIdentity.accountId || "?") + " (allowOverwrite=true)");
  }

  if (expectedIdentity) {
    const expectedAccountId = String(expectedIdentity.accountId || "").trim();
    const expectedPub = String(expectedIdentity.publicKeyB64 || "").trim();
    const expectedPriv = String(expectedIdentity.privateKeyB64 || "").trim();
    if (!expectedAccountId || !expectedPub || !expectedPriv) {
      throw new Error("ensureChatServerIdentity: expectedIdentity must include accountId, publicKeyB64, privateKeyB64");
    }
    const record = new StoredServerIdentity({
      accountId: expectedAccountId,
      deviceId: `dev:${randomBytes(8).toString("hex")}`,
      publicKeyB64: expectedPub,
      privateKeyB64: expectedPriv,
    });
    await kv.set(STORE_KEY, record.toJSON());
    return record;
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
