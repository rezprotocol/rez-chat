import { bootstrapChatRuntime } from "../server/bootstrap/bootstrapChatRuntime.js";
import { MobileLifecycleAdapter } from "../server/runtime/MobileLifecycleAdapter.js";

/**
 * startRezChatCore — the HEADLESS mobile core boot
 * (P1.1, plans/MOBILE_PLATFORM_INTEGRATION_PLAN.md).
 *
 * The one question this module answers: boot rez-chat as a complete
 * claimant-mode runtime with no desktop supervisor, no local rez-node, and
 * no UI/WebView assumptions, given only platform-provided providers and
 * remote uplinks. It is the mobile analogue of the desktop composition
 * chain, with every desktop concern absent:
 *
 *     desktop: startRezChat → local node + HTTP shell + vault + supervisor
 *              → bootstrapChatServer (fs/NodeCrypto/ws adapter)
 *              → bootstrapChatRuntime
 *     mobile:  host keystore/paths → startRezChatCore({providers})
 *              → bootstrapChatRuntime  (the SAME platform-neutral core)
 *
 * RUNTIME-NEUTRAL by ruling: no JSC/JSE binding here, no `node:` imports,
 * no platform imports — the same module runs under Node in deterministic
 * tests and under a native-hosted JS engine in production. The mechanical
 * guardrail test (`mobile.core-boundary.test.js`) enforces that this
 * module's transitive graph never reaches `node:` builtins,
 * `@rezprotocol/node`, the desktop tree, or the shell host.
 *
 * ARCHITECTURAL GUARDRAIL (frozen): this entry point accepts providers and
 * configuration ONLY — it must never grow mobile-specific domain methods
 * (no renewMailbox(), no syncMessages(), no recoverAfterPush()). Those
 * decisions already live behind the runtime directives and the adapter;
 * a host that wants work done calls a lifecycle hook.
 *
 * F8/M7 hold at THIS seam, not merely once ChatServerApp exists: the boot
 * is claimant-by-default, constructs no account-mode client anywhere on the
 * boot path (the AccountControlChannel inside ChatServerApp is demand-
 * driven and never connects on its own), and hands back the adapter
 * pre-wired with the close-only suspend capability.
 *
 * @param {object} opts
 * @param {object} opts.identity — the chat-server identity (mobile v1: the
 *   DELEGATED shape from enrollment — hasAdminRoot:false + certChain; the
 *   host's keystore is its source of truth).
 * @param {object|null} opts.deviceKey — the persisted device key C
 *   ({deviceKeyPair, deviceId}); required for the delegated shape.
 * @param {object} opts.storageProvider — platform storage behind the
 *   provider seam (SqliteStorageProvider on device; any KV provider in
 *   tests). Contract: `getKeyValueStore(name)` + `getPeerLinkStorage()` —
 *   the sdk's `createKeyValueBackedPeerLinkStorage({keyValueStore})`
 *   composes the latter from the former, so a host only ever implements a
 *   KV store. Durable truth lives here and ONLY here.
 * @param {object} opts.cryptoProvider — platform crypto behind the provider
 *   seam (NativeCryptoProvider on device; BrowserCryptoProvider or the
 *   Node provider in tests).
 * @param {string[]} opts.uplinks — REMOTE provider wsUrls. There is no
 *   local node on a phone; nothing here can start one.
 * @param {(url: string) => object} opts.wsFactory — the platform WebSocket.
 * @param {string} [opts.expectedNodePublicKeyB64] — provider identity pin.
 * @param {string} [opts.sessionMode="claimant"] — mobile boots CLAIMANT by
 *   default (Portable Home's closed success condition: ordinary lifecycle
 *   through claimant data-plane access only). Explicit override exists for
 *   the same reason resolveSessionMode's does: topology knowledge, never
 *   discovery.
 * @param {string} [opts.retentionClass="standard"] — the phone's portable
 *   inbox runs the durable lease/grace/reclaim lifecycle by default; the
 *   adapter's renewLeaseIfDue and the M6 re-mint path exist for exactly
 *   this class.
 * @param {function} [opts.clock]
 * @param {object} [opts.logger]
 * @returns {Promise<{chatServer, adapter, bridge, ownerAccountId, inboxClaimant, storageProvider}>}
 *   `chatServer.start()` is the boot (offline-tolerant per M1);
 *   `adapter.on*()` are the ONLY verbs a host calls afterward; `bridge` is
 *   the generic UI transport (same no-facade contract as desktop).
 */
export async function startRezChatCore({
  identity,
  deviceKey = null,
  storageProvider,
  cryptoProvider,
  uplinks,
  wsFactory,
  expectedNodePublicKeyB64 = "",
  sessionMode = "claimant",
  retentionClass = "standard",
  clock = () => Date.now(),
  logger = console,
} = {}) {
  if (typeof wsFactory !== "function") {
    throw new Error("startRezChatCore requires wsFactory (the platform WebSocket implementation)");
  }
  // P1.3b (frozen R3 phase invariants): a DELEGATED mobile identity boots in
  // the "portable" inbox role — the steady-state runtime inbox comes from the
  // claim store's portable primary ONLY. No portable primary means the
  // enrollment/activation transaction (activateDelegatedDevice) did not
  // finish; the boot fails with ENROLLMENT_INCOMPLETE so the host resumes it.
  // The envelope's bootstrap inbox is NEVER selected as the primary here —
  // there is no fallback, by ruling. A primary (seedful) mobile identity
  // keeps the shipped legacy resolution (fresh-mint + persisted primary).
  const delegated = identity && typeof identity === "object" && identity.hasAdminRoot === false;
  const bootstrapped = await bootstrapChatRuntime({
    identity,
    deviceKey,
    storageProvider,
    cryptoProvider,
    uplinks,
    expectedNodePublicKeyB64,
    wsFactory,
    sessionMode,
    retentionClass,
    inboxRole: delegated ? "portable" : "legacy",
    clock,
    logger,
  });
  const bus = bootstrapped.chatServer.bus;
  const adapter = new MobileLifecycleAdapter({
    bus,
    // Close-only capability (M7 frozen construction): the adapter never
    // holds the AccountControlChannel — backgrounding can suspend authority
    // exposure, and nothing on a wake path can express account authority.
    suspendAccountControl: bus.runtime.accountControl
      ? () => bus.runtime.accountControl.suspend()
      : null,
    logger,
  });
  return {
    chatServer: bootstrapped.chatServer,
    adapter,
    bridge: bootstrapped.chatServer.bridge,
    ownerAccountId: bootstrapped.ownerAccountId,
    inboxClaimant: bootstrapped.inboxClaimant,
    storageProvider: bootstrapped.storageProvider,
  };
}
