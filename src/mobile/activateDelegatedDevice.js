import { bootstrapChatRuntime } from "../server/bootstrap/bootstrapChatRuntime.js";
import { PortableInboxEstablisher } from "../server/inbox/PortableInboxEstablisher.js";
import { DeviceActivationJournal, ACTIVATION_STATES } from "../server/device/DeviceActivationJournal.js";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * activateDelegatedDevice — the BOUNDED enrollment/activation session
 * (P1.3b, plans/MOBILE_PLATFORM_INTEGRATION_PLAN.md; frozen rulings
 * 2026-08-26). The split-transport activation transaction, end to end:
 *
 *     delegated envelope exists (enrollDelegatedDevice, P1.3a)
 *         ↓ bounded ACCOUNT session to the pg home (account-legacy — F9:
 *           the shared durable home requires the identity-bearing path,
 *           and enrollment is the ONE place it is allowed)
 *         claim bootstrap inbox exactly (enrollment role — never recorded
 *           as any primary) · device.bind · activation BOOTSTRAPPING
 *         ↓ baseline requested every sync, drained via the bootstrap inbox
 *         READY
 *         ↓ portable per-device inbox established (fresh random claimant,
 *           fresh close key, generation 1, standard lease at the PORTABLE
 *           provider; claim + lease durably persisted) — inside the
 *           publication seam, BEFORE the wire op
 *         bundle published carrying the PORTABLE inboxId → ACTIVE
 *         ↓ the ACCOUNT session ends (stop — bounded means bounded)
 *     steady state: startRezChatCore() → CLAIMANT against the portable
 *     provider; no ceremony repeats; no ACCOUNT session is constructed
 *
 * Crash/idempotence boundaries (ruled):
 *   - kill before READY            → rerun resumes BOOTSTRAPPING (journal)
 *   - kill after portable persist,
 *     before publication           → rerun REUSES the persisted portable
 *                                    claim (pointer) and publishes once —
 *                                    never mints another inbox
 *   - kill after publication,
 *     before journal ACTIVE        → rerun observes the published bundle
 *                                    and converges to ACTIVE (network truth
 *                                    wins — the shipped activation rule)
 *   - portable provider down at
 *     READY                        → remain READY/unpublished and
 *                                    recoverable; **no bootstrap-inbox
 *                                    fallback exists anywhere** (frozen:
 *                                    activation cannot commit until the
 *                                    portable inbox is durably established)
 *
 * After ACTIVE the bootstrap inbox is dormant (R2): nothing re-claims,
 * renews, or publishes it — its lease simply lapses at the provider.
 *
 * Runtime-neutral like its siblings: providers in, one verb whose name is
 * the transaction, no domain methods beyond it. The boundary walk covers
 * this third entry point with the same bans.
 *
 * @param {object} opts
 * @param {object} opts.identity — the DELEGATED chat-server identity from
 *   the unlocked envelope: {accountId, publicKeyB64, hasAdminRoot:false,
 *   certChain, accountIdentityDhKeyPair, bootstrapInboxId}. The account
 *   root cannot exist in it.
 * @param {object} opts.deviceKey — {deviceId, deviceKeyPair} (the persisted C).
 * @param {object} opts.storageProvider — the SAME host storage the steady-
 *   state boot uses (the journal, claim store and portable pointer live in
 *   it; that continuity IS the crash recovery).
 * @param {object} opts.cryptoProvider — platform RCryptoProvider.
 * @param {string[]} opts.accountHomeUplinks — the pg home wsUrls (the
 *   bounded ACCOUNT session).
 * @param {string[]} opts.portableUplinks — the portable provider wsUrls
 *   (the permanent per-device inbox).
 * @param {(url: string) => object} opts.wsFactory — the platform WebSocket.
 * @param {string} [opts.expectedAccountHomeNodePublicKeyB64]
 * @param {string} [opts.expectedPortableNodePublicKeyB64]
 * @param {function} [opts.clock]
 * @param {number} [opts.timeoutMs] — how long this foreground run waits for
 *   ACTIVE before throwing ACTIVATION_TIMEOUT (durable state remains
 *   resumable; rerun the verb).
 * @param {number} [opts.pollIntervalMs]
 * @param {object} [opts.logger]
 * @returns {Promise<{activated: true, alreadyActive: boolean, state: "ACTIVE",
 *   accountId: string, deviceId: string, portableInboxId: string}>}
 */
export async function activateDelegatedDevice({
  identity,
  deviceKey,
  storageProvider,
  cryptoProvider,
  accountHomeUplinks,
  portableUplinks,
  wsFactory,
  expectedAccountHomeNodePublicKeyB64 = "",
  expectedPortableNodePublicKeyB64 = "",
  clock = () => Date.now(),
  timeoutMs = 180_000,
  pollIntervalMs = 500,
  logger = console,
} = {}) {
  if (!identity || typeof identity !== "object" || identity.hasAdminRoot !== false) {
    throw new Error("activateDelegatedDevice requires a DELEGATED identity (hasAdminRoot: false) — activation is the enrollment transaction, not a primary-device concern");
  }
  const bootstrapInboxId = typeof identity.bootstrapInboxId === "string" && identity.bootstrapInboxId.trim().length > 0
    ? identity.bootstrapInboxId.trim()
    : "";
  if (!bootstrapInboxId) {
    throw new Error("activateDelegatedDevice requires identity.bootstrapInboxId (the ceremony's pre-registered enrollment inbox)");
  }
  if (!Array.isArray(identity.certChain) || identity.certChain.length === 0) {
    throw new Error("activateDelegatedDevice requires identity.certChain");
  }
  if (!deviceKey || !deviceKey.deviceId || !deviceKey.deviceKeyPair) {
    throw new Error("activateDelegatedDevice requires deviceKey (the persisted device key C)");
  }
  if (!storageProvider || typeof storageProvider.getKeyValueStore !== "function") {
    throw new Error("activateDelegatedDevice requires storageProvider (the same one the steady-state boot uses)");
  }
  if (!cryptoProvider || typeof cryptoProvider !== "object") {
    throw new Error("activateDelegatedDevice requires cryptoProvider");
  }
  if (!Array.isArray(accountHomeUplinks) || accountHomeUplinks.length === 0) {
    throw new Error("activateDelegatedDevice requires accountHomeUplinks (the pg home)");
  }
  if (!Array.isArray(portableUplinks) || portableUplinks.length === 0) {
    throw new Error("activateDelegatedDevice requires portableUplinks (the portable provider)");
  }
  if (typeof wsFactory !== "function") {
    throw new Error("activateDelegatedDevice requires wsFactory (the platform WebSocket implementation)");
  }
  if (typeof clock !== "function") {
    throw new Error("activateDelegatedDevice requires clock()");
  }

  const establisher = new PortableInboxEstablisher({
    storageProvider,
    cryptoProvider,
    uplinks: portableUplinks,
    wsFactory,
    expectedNodePublicKeyB64: expectedPortableNodePublicKeyB64,
    bootstrapInboxId,
    clock,
    logger,
  });

  // Durable state FIRST, before anything account-shaped exists: an already-
  // committed activation returns without constructing an ACCOUNT session
  // (the frozen steady-state rule — kill + restart → zero ACCOUNT
  // construction belongs to startRezChatCore, and an idempotent rerun of
  // this verb must not violate it either).
  const journal = new DeviceActivationJournal({ storageProvider });
  await journal.hydrate();
  const record = journal.get();
  const establishedBefore = await establisher.establishedInboxId();
  if (record && record.state === ACTIVATION_STATES.ACTIVE) {
    if (!establishedBefore) {
      // ACTIVE with no portable primary is not a resumable halfway state —
      // it means an activation committed WITHOUT the split transport (or the
      // pointer was lost). Publishing already happened; guessing a new
      // address now would strand peers. Surface it.
      throw new Error("activateDelegatedDevice: the activation journal is ACTIVE but no portable primary exists — "
        + "this storage did not complete a split-transport activation; refusing to guess");
    }
    return {
      activated: true,
      alreadyActive: true,
      state: ACTIVATION_STATES.ACTIVE,
      accountId: String(identity.accountId || ""),
      deviceId: deviceKey.deviceId,
      portableInboxId: establishedBefore,
    };
  }

  // The bounded ACCOUNT session: the full delegated runtime against the pg
  // home — the same machinery the desktop delegated leaf runs (baseline
  // drain needs the whole account-state apply pipeline) — in the
  // "enrollment" inbox role, with the portable establisher wired into the
  // one publication seam.
  const bootstrapped = await bootstrapChatRuntime({
    identity: {
      accountId: identity.accountId,
      publicKeyB64: identity.publicKeyB64,
      privateKeyB64: null,
      hasAdminRoot: false,
      certChain: identity.certChain,
      accountIdentityDhKeyPair: identity.accountIdentityDhKeyPair || null,
      inboxId: bootstrapInboxId,
    },
    deviceKey,
    storageProvider,
    cryptoProvider,
    uplinks: accountHomeUplinks,
    expectedNodePublicKeyB64: expectedAccountHomeNodePublicKeyB64,
    wsFactory,
    sessionMode: "account-legacy",
    retentionClass: "transient",
    inboxRole: "enrollment",
    portableInboxEstablisher: establisher,
    clock,
    logger,
  });
  const chatServer = bootstrapped.chatServer;
  try {
    await chatServer.start();
    const deadlineAtMs = clock() + timeoutMs;
    // The marker path drives BOOTSTRAPPING → READY → commit on its own; the
    // slow re-sync below exists for the RETRY cases — a commit that failed
    // (e.g. the portable provider was unreachable at READY) is retried by
    // the sync's READY branch, and a lost baseline is re-requested (the
    // answerer throttles per activationId). Never at poll frequency: a
    // baseline re-request each 500ms would spam the home.
    const SYNC_RETRY_INTERVAL_MS = 10_000;
    let lastSyncAtMs = clock();
    for (;;) {
      const status = await chatServer.bus.call("device-activation", "status", {});
      if (status && status.state === ACTIVATION_STATES.ACTIVE) break;
      if (clock() >= deadlineAtMs) {
        const err = new Error("activateDelegatedDevice: activation did not reach ACTIVE within " + timeoutMs
          + "ms (state: " + String(status && status.state) + ") — durable state is resumable; rerun to continue");
        err.code = "ACTIVATION_TIMEOUT";
        err.state = status && status.state ? status.state : "";
        throw err;
      }
      if (clock() - lastSyncAtMs >= SYNC_RETRY_INTERVAL_MS) {
        lastSyncAtMs = clock();
        try {
          await chatServer.bus.call("device-activation", "sync", {});
        } catch (err) {
          logger.warn("activateDelegatedDevice: activation sync retry failed (still waiting): "
            + (err && err.message ? err.message : err));
        }
      }
      await sleep(pollIntervalMs);
    }
  } finally {
    // Bounded means bounded: the ACCOUNT session ends on EVERY path —
    // success, timeout, or failure. Suspension of account exposure is the
    // stop itself; steady state never reconstructs it.
    try {
      await chatServer.stop();
    } catch (err) {
      logger.error("activateDelegatedDevice: enrollment runtime stop failed", err && err.message ? err.message : err);
    }
  }

  const portableInboxId = await establisher.establishedInboxId();
  if (!portableInboxId) {
    // ACTIVE is only reachable through the commit, and the commit publishes
    // through the establisher — a missing pointer here is an invariant
    // breach, never a recoverable state.
    throw new Error("activateDelegatedDevice: activation reached ACTIVE but no portable primary is recorded — invariant breach");
  }
  return {
    activated: true,
    alreadyActive: false,
    state: ACTIVATION_STATES.ACTIVE,
    accountId: String(identity.accountId || ""),
    deviceId: deviceKey.deviceId,
    portableInboxId,
  };
}
