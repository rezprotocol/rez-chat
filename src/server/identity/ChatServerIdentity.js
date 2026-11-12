import { randomBytes } from "node:crypto";
import { StoredServerIdentity } from "../../records/domain/StoredServerIdentity.js";

const STORE_KEY = "chat-server:identity:v1";

/**
 * Verifies the persisted public identity against the vault-supplied identity.
 * Never generates an account or loads its private key from an unprotected row.
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
 * @param {object} options.expectedIdentity - Required vault-derived identity.
 *     Only its public identity is persisted. If a stored
 *     identity exists with a different pubkey, the call throws unless
 *     `allowOverwrite` is true (the once-per-account rotation case at first
 *     account-creation after a fresh boot).
 * @param {boolean} [options.allowOverwrite=false] - Replace any existing
 *     stored identity with `expectedIdentity` if they differ. Logged loudly.
 */
export async function ensureChatServerIdentity({
  storageProvider,
  expectedIdentity = null,
  allowOverwrite = false,
} = {}) {
  if (!storageProvider || typeof storageProvider.getKeyValueStore !== "function") {
    throw new Error("ensureChatServerIdentity requires storageProvider");
  }
  if (!expectedIdentity) {
    const err = new Error("ensureChatServerIdentity: vault expectedIdentity is required to boot; refusing to generate an account");
    err.code = "ROOT_KEY_IN_VAULT_BUT_NOT_SUPPLIED";
    throw err;
  }
  const expectedAccountId = String(expectedIdentity.accountId || "").trim();
  const expectedPub = String(expectedIdentity.publicKeyB64 || "").trim();
  const expectedPriv = String(expectedIdentity.privateKeyB64 || "").trim();
  const delegated = expectedIdentity.hasAdminRoot === false;
  if (!expectedAccountId || !expectedPub || (!delegated && !expectedPriv)) {
    throw new Error("ensureChatServerIdentity: expectedIdentity must include accountId, publicKeyB64, privateKeyB64");
  }
  if (delegated && expectedPriv) {
    throw new Error("ensureChatServerIdentity: a delegated expectedIdentity must not carry privateKeyB64");
  }
  if (delegated && !String(expectedIdentity.deviceId || "").trim()) {
    throw new Error("ensureChatServerIdentity: a delegated expectedIdentity must include accountId, publicKeyB64, deviceId");
  }
  const kv = storageProvider.getKeyValueStore(null);
  if (typeof kv.getStrict !== "function") throw new Error("ensureChatServerIdentity requires strict storage reads");
  const stored = await kv.getStrict(STORE_KEY);
  let storedRecord = null;
  if (stored !== undefined) {
    // Corrupt is never absent: preserve the row and fail closed, even when
    // rotation was requested. It may be the last evidence of an existing account.
    storedRecord = new StoredServerIdentity(stored);
  }

  if (storedRecord) {
    if (storedRecord.publicKeyB64 === expectedPub) {
      if (storedRecord.accountId !== expectedAccountId || storedRecord.hasAdminRoot === delegated) {
        throw new Error("ensureChatServerIdentity: stored identity authority does not match expectedIdentity");
      }
      // GHSA-7gc9-4c96-2rxm — the scrub, and the ONLY place cleartext root key
      // material is removed from disk.
      //
      // Ruling (Noah, 2026-08-30): remove the on-disk copy only once the key is
      // PROVEN to be where it should be. The proof is this equality: the vault
      // just handed us a private key, and it is byte-identical to the one on
      // disk. That establishes the envelope opens and yields the same key on
      // THIS machine, so the disk copy is provably redundant rather than
      // presumed so. If they ever differ we scrub nothing and fall through to
      // the mismatch handling below.
      const storedPriv = String(storedRecord.privateKeyB64 || "").trim();
      const isAdminRoot = storedRecord.hasAdminRoot !== false;
      if (isAdminRoot && storedRecord.rootKeyCustody === "inline" && storedPriv) {
        if (storedPriv !== expectedPriv) {
          const err = new Error(
            "ensureChatServerIdentity: stored identity " + storedRecord.accountId
            + " has the expected public key but a DIFFERENT private key. Refusing to scrub — "
            + "this is key confusion, not an upgrade.",
          );
          err.code = "ROOT_KEY_MISMATCH_SAME_PUBKEY";
          throw err;
        }
        const scrubbed = new StoredServerIdentity({
          accountId: storedRecord.accountId,
          deviceId: storedRecord.deviceId,
          publicKeyB64: storedRecord.publicKeyB64,
          privateKeyB64: "",
          rootKeyCustody: "vault",
        });
        await kv.set(STORE_KEY, scrubbed.toJSON());
        console.warn("[chat-server] scrubbed the cleartext root key; the vault envelope is now its only home (GHSA-7gc9-4c96-2rxm)");
        // The RUNTIME identity still needs the key — it just no longer comes
        // off disk. `expectedIdentity` (the vault) is now its sole source.
        return new StoredServerIdentity({
          accountId: storedRecord.accountId,
          deviceId: storedRecord.deviceId,
          publicKeyB64: storedRecord.publicKeyB64,
          privateKeyB64: expectedPriv,
        });
      }
      if (isAdminRoot && storedRecord.rootKeyCustody === "vault") {
        // Already scrubbed. Rehydrate the runtime identity from the vault.
        return new StoredServerIdentity({
          accountId: storedRecord.accountId,
          deviceId: storedRecord.deviceId,
          publicKeyB64: storedRecord.publicKeyB64,
          privateKeyB64: expectedPriv,
        });
      }
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

  // S9 delegated branch: a seedless device holds NO account private key —
  // its row persists the account PUBLIC key + the self-certifying deviceId
  // of the device key C. A delegated identity that DOES carry a private key
  // is a contradiction (someone parked admin-root material on a device that
  // must not have it) — fail loud rather than persist it.
  if (expectedIdentity.hasAdminRoot === false) {
    const delegatedDeviceId = String(expectedIdentity.deviceId || "").trim();
    const record = new StoredServerIdentity({
      accountId: expectedAccountId,
      deviceId: delegatedDeviceId,
      publicKeyB64: expectedPub,
      privateKeyB64: "",
      hasAdminRoot: false,
    });
    await kv.set(STORE_KEY, record.toJSON());
    return record;
  }
  // GHSA-7gc9-4c96-2rxm: the private key is NOT persisted. The vault
  // envelope supplies it at every boot (rez-chat/src/index.js is the only
  // production caller and always does), so writing it here only ever created
  // a second, unprotected copy.
  const deviceId = `dev:${randomBytes(8).toString("hex")}`;
  const record = new StoredServerIdentity({
    accountId: expectedAccountId,
    deviceId,
    publicKeyB64: expectedPub,
    privateKeyB64: "",
    rootKeyCustody: "vault",
  });
  await kv.set(STORE_KEY, record.toJSON());
  return new StoredServerIdentity({
    accountId: expectedAccountId,
    deviceId,
    publicKeyB64: expectedPub,
    privateKeyB64: expectedPriv,
  });
}
