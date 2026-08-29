import {
  createRezClient,
  createDelegatedKeystoreAccount,
  bytesToBase64,
  deriveAccountIdFromPublicKey,
  deriveDeviceIdFromPublicKeyB64,
} from "@rezprotocol/sdk/client";
import { runDeviceLinkRequester as runSdkRequester } from "@rezprotocol/sdk/device-link";

/**
 * enrollDelegatedDevice — the RUNTIME-NEUTRAL device-enrollment ceremony
 * (P1.3a, plans/P1_3_ENROLLMENT_TRACE.md §8).
 *
 * The one question this module answers: given a link code read off the
 * primary's screen and platform-provided providers, run the NEW-device half
 * of the PSK ceremony and leave the delegated envelope in host custody. It
 * is the mobile analogue of the desktop/browser device-link runners, with
 * every host concern injected:
 *
 *     desktop: DesktopDeviceLinkRunner (node ws + NodeCrypto + vault)
 *     browser: BrowserDeviceLinkRunner (globalThis.WebSocket + IndexedDB)
 *     mobile:  host wsFactory/crypto/keystoreStore → enrollDelegatedDevice
 *
 * RUNTIME-NEUTRAL by the same ruling as startRezChatCore: no `node:`
 * imports, no platform globals, no desktop/browser runner imports — the
 * boundary walk in `mobile.core-boundary.test.js` covers this second entry
 * point with the same bans.
 *
 * What it owns, and ONLY this (frozen scope, 2026-08-26 ruling): parse the
 * opaque link code (inside the SDK requester) → requester ceremony over a
 * THROWAWAY account-blind rendezvous client → delegation verified (real
 * verifyAccountAuthority, inside the requester, before any confirmation) →
 * seal/persist the delegated envelope into the host keystoreStore → confirm
 * → return `{accountId, deviceId, bootstrapInboxId}`. No runtime boot, no portable
 * inbox, no activation, no account-control session — those are P1.3b/c.
 *
 * FAILURE ORDERING (the P1.3a acceptance boundary):
 *
 *   delegation verified → envelope durably persisted → confirmation allowed
 *
 * The SDK requester enforces the sequence (it requires persistDelegation and
 * publishes the confirm record only after it resolves); this module makes
 * the persistence real: `createDelegatedKeystoreAccount` seals C, B-dh, the
 * cert chain and the ceremony's pre-registered inbox under the host's unlock
 * secret in ONE envelope put. Never confirm first and then discover the
 * host could not store the only copy of C.
 *
 * Honest kill behavior (frozen): before envelope persistence, process death
 * means ceremony restart — no requester journaling exists around ephemeral
 * ceremony crypto that cannot actually resume; the approver's durable
 * ceremony journal owns the compensating revoke. A failure AFTER
 * persistence but BEFORE the ceremony completes clears the envelope for the
 * same reason the browser runner does: the primary never saw the confirm,
 * its journal will revoke the cert, and a persisted envelope must not
 * remain looking usable.
 *
 * The envelope's `bootstrapInboxId` (R3) is the BOOTSTRAP/ceremony inbox —
 * the self-minted, device.add-pre-registered address the device claims for
 * activation — NOT the lifetime portable address. The portable primary is
 * established by `activateDelegatedDevice` (P1.3b) and owned by the claim
 * store.
 *
 * @param {object} opts
 * @param {string} opts.linkCode — the opaque `rez:link:v1:` code (QR/paste).
 * @param {string} opts.password — the host's envelope unlock secret (the
 *   existing password KDF path of the §7 host contract; a host wrapping-key
 *   seal is future work, not this module's).
 * @param {string} [opts.profileName]
 * @param {object} opts.cryptoProvider — platform crypto behind the provider
 *   seam (NativeCryptoProvider on device; Node/Browser providers in tests).
 *   This is the RCryptoProvider the CEREMONY runs on.
 * @param {object|null} [opts.keystoreCryptoProvider] — the WEBCRYPTO surface
 *   ({subtle, getRandomValues} or a `crypto`-shaped object) the envelope KDF
 *   seals with — a DIFFERENT seam than the RCryptoProvider, by the core
 *   keystore's own contract. null (the default) resolves `globalThis.crypto`,
 *   which is correct under Node, browsers, and any host that installs the
 *   standard global; a host without one injects its own here.
 * @param {(url: string) => object} opts.wsFactory — the platform WebSocket.
 * @param {string[]} opts.uplinks — REMOTE provider wsUrls (the linking-
 *   capable hosted home; there is no local node on a phone).
 * @param {object} opts.keystoreStore — host-backed KeystoreStore
 *   ({hasKeystore, putKeystoreEnvelope, clearKeystore}); durable custody of
 *   the delegated envelope lives here and ONLY here.
 * @param {function} [opts.clock] — ms clock, threaded to the requester.
 * @param {string} [opts.expectedNodePublicKeyB64] — provider identity pin.
 * @param {number} [opts.timeoutMs] — ceremony deadline.
 * @param {function} [opts.onStatus] — requester phase callback for host UI.
 * @param {object} [opts.logger]
 * @returns {Promise<{accountId: string, deviceId: string, bootstrapInboxId: string}>}
 *   The sealed envelope's identity facts — never key material; the host
 *   unlocks the envelope to boot (P1.3c).
 */
export async function enrollDelegatedDevice({
  linkCode,
  password,
  profileName = "",
  cryptoProvider,
  keystoreCryptoProvider = null,
  wsFactory,
  uplinks,
  keystoreStore,
  clock = () => Date.now(),
  expectedNodePublicKeyB64 = "",
  timeoutMs = 180_000,
  onStatus = null,
  logger = console,
  sdkFactory = createRezClient,
  requester = runSdkRequester,
} = {}) {
  const code = typeof linkCode === "string" ? linkCode.trim() : "";
  if (!code) throw new Error("enrollDelegatedDevice requires linkCode");
  const pwd = typeof password === "string" ? password : "";
  if (!pwd) throw new Error("enrollDelegatedDevice requires password (the host's envelope unlock secret)");
  if (!cryptoProvider || typeof cryptoProvider !== "object") {
    throw new Error("enrollDelegatedDevice requires cryptoProvider (the platform crypto provider)");
  }
  if (typeof wsFactory !== "function") {
    throw new Error("enrollDelegatedDevice requires wsFactory (the platform WebSocket implementation)");
  }
  if (!Array.isArray(uplinks) || uplinks.length === 0) {
    throw new Error("enrollDelegatedDevice requires uplinks (remote provider wsUrls)");
  }
  if (!keystoreStore
    || typeof keystoreStore.hasKeystore !== "function"
    || typeof keystoreStore.putKeystoreEnvelope !== "function"
    || typeof keystoreStore.clearKeystore !== "function") {
    throw new Error("enrollDelegatedDevice requires keystoreStore {hasKeystore, putKeystoreEnvelope, clearKeystore}");
  }
  if (typeof clock !== "function") {
    throw new Error("enrollDelegatedDevice requires clock() (a ms clock function)");
  }

  // Refuse BEFORE any network touch: a ceremony that would only fail at the
  // persistence step still commits device.add at the home and burns the link
  // code — stranding a registered device whose key the host cannot store.
  if (await keystoreStore.hasKeystore()) {
    throw new Error("enrollDelegatedDevice: keystoreStore already holds an envelope — this store enrolls at most one device");
  }

  // Throwaway account-blind session identity: any self-generated key can
  // session-auth (the protocol is account-blind); it reaches only the
  // durable-record rendezvous slots and is discarded when the ceremony ends.
  const session = await cryptoProvider.generateSigningKeyPair();
  const sessionPubB64 = bytesToBase64(session.publicKey);
  const sdk = sdkFactory({
    identity: {
      accountId: deriveAccountIdFromPublicKey(session.publicKey),
      deviceId: deriveDeviceIdFromPublicKeyB64(sessionPubB64),
      publicKeyB64: sessionPubB64,
      privateKeyB64: bytesToBase64(session.privateKey),
    },
    uplinks,
    clientVersion: "rez-chat-mobile-enroll/1.0",
    wsFactory,
    expectedNodePublicKeyB64: typeof expectedNodePublicKeyB64 === "string" ? expectedNodePublicKeyB64.trim() : "",
  });
  if (!sdk || typeof sdk.connect !== "function" || typeof sdk.close !== "function" || !sdk.durableRecords) {
    throw new Error("enrollDelegatedDevice: SDK factory returned an invalid client");
  }

  let persisted = null;
  const persistDelegation = async (result) => {
    const delegation = result && result.delegation && typeof result.delegation === "object"
      ? result.delegation
      : null;
    if (!delegation) throw new Error("enrollDelegatedDevice: ceremony returned no delegation bundle");
    // Validated HERE, before sealing — this is the last moment a failure is
    // still pre-confirm. Mobile v1 has no legacy inbox-less envelopes: the
    // ceremony always pre-registers the bootstrap inbox via device.add.
    const bootstrapInboxId = typeof result.inboxId === "string" ? result.inboxId.trim() : "";
    if (!bootstrapInboxId) throw new Error("enrollDelegatedDevice: ceremony returned no bootstrap inboxId");
    const created = await createDelegatedKeystoreAccount({
      password: pwd,
      profileName,
      keystoreStore,
      cryptoProvider: keystoreCryptoProvider,
      delegation: {
        accountSignPublicKeyB64: delegation.accountSignPublicKeyB64,
        accountDhKeyPair: delegation.accountDhKeyPair,
        deviceKeyPair: delegation.deviceKeyPair,
        certChain: delegation.certChain,
        cachedDeviceSet: delegation.cachedDeviceSet === undefined ? null : delegation.cachedDeviceSet,
        bootstrapInboxId,
      },
    });
    persisted = { accountId: created.accountId, deviceId: created.deviceId, bootstrapInboxId };
    return persisted;
  };

  try {
    await sdk.connect();
    await requester({
      code,
      crypto: cryptoProvider,
      records: sdk.durableRecords,
      nowMs: clock,
      deadlineMs: timeoutMs,
      onStatus,
      persistDelegation,
    });
    if (!persisted) {
      throw new Error("enrollDelegatedDevice: ceremony completed without a durable envelope");
    }
    return { accountId: persisted.accountId, deviceId: persisted.deviceId, bootstrapInboxId: persisted.bootstrapInboxId };
  } catch (err) {
    if (persisted) {
      // Post-persist, pre-completion failure: the primary never saw the
      // confirm, so its ceremony journal owns the compensating revoke — a
      // persisted envelope must not remain looking usable.
      try {
        await keystoreStore.clearKeystore();
      } catch (cleanupErr) {
        logger.error(
          "[mobile-enroll] failed to clear the envelope after a post-persist ceremony failure — host custody holds a stranded delegated envelope",
          cleanupErr && cleanupErr.message ? cleanupErr.message : cleanupErr,
        );
      }
    }
    throw err;
  } finally {
    try {
      await sdk.close();
    } catch (err) {
      logger.warn("[mobile-enroll] temporary rendezvous client close failed", err && err.message ? err.message : err);
    }
  }
}
