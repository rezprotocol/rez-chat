import { createRezClient } from "@rezprotocol/sdk/client";
import { ConnectionStateEvent, NodeCapabilitiesEvent } from "../../records/index.js";
import { BaseServerService } from "../base/BaseServerService.js";
import { MailboxPushBridge } from "../runtime/MailboxPushBridge.js";
import { nodeAdvertisesDurableInbox, nodeRequiresProvenDevice, nodeEnablesMultiDeviceFanout, nodeSupportsDeviceLinking } from "../inbox/durableMode.js";
import { registerInboxClaimOnSession } from "../inbox/inboxClaimWire.js";

function mapPoolPhaseToStatus(phase) {
  const value = String(phase || "").trim().toLowerCase();
  if (value === "connected") return "connected";
  if (value === "offline") return "offline";
  if (value === "reconnecting") return "reconnecting";
  if (value === "failover") return "connecting";
  return "";
}

/**
 * ServerRuntimeService owns the chat-server's connection to its node — wherever
 * that node lives. There is no second "in-process" pointer; the SDK client is
 * the only handle. Whether the node is on localhost or a hosted VPS is purely
 * a question of the wsUrl.
 */
export class ServerRuntimeService extends BaseServerService {
  #sdk;
  #connected;
  #lastStatus;
  #offState;
  #offReconnect;
  #offMailboxPushBridge;
  #reconnectPromise;

  // M1 (plans/MOBILE_LIFECYCLE_ADAPTER_PLAN.md): true when the FIRST connect
  // failed with a retryable (network-shaped) error, so the bind is owed and
  // the pool's first successful background reconnect must complete it. Never
  // set for terminal home rejections — a refused home is not an unreachable
  // home, and it keeps failing loudly.
  #connectPending;
  #connectInFlight;
  #clock;
  #retentionClass;

  #inboxClaimant;

  // S10: whether this identity holds the account root (B-sign private key).
  // A DELEGATED identity binds with its device-signed inbox binding only —
  // the session cert chain is its registration.
  #hasAccountKey;

  // F8 (plans/F8_REZCHAT_ROLE_SPLIT_PLAN.md): which session model this
  // deployment runs. CONFIGURATION, never discovery — selecting the legacy
  // identity-bearing path must not be triggered by what a node advertises
  // mid-handshake (that would be a downgrade oracle).
  //   "account-legacy" (default) — the shipped path, byte-identical: one
  //     account-authenticated session carries both planes. Required for PG
  //     shared durable homes (F9: their cursor model is device-keyed).
  //   "claimant" — the privacy-preserving path for per-device/transient
  //     mailbox shapes: the data plane authenticates with the inbox claimant
  //     key ONLY; account-control work goes through the on-demand
  //     AccountControlChannel, never this session.
  #sessionMode;

  constructor({
    bus,
    identity,
    uplinks,
    sdk = null,
    peerLinkService = null,
    inboxClaimant = null,
    expectedNodePublicKeyB64 = "",
    wsFactory = null,
    sessionMode = "account-legacy",
    // P1.1 (plans/MOBILE_PLATFORM_INTEGRATION_PLAN.md): the retention class
    // this runtime SELECTS for its inbox lease. "transient" is the shipped
    // desktop default (byte-identical: RMailbox caps, no expiry lifecycle);
    // the mobile core boots "standard" so the durable lease/grace/reclaim
    // lifecycle Portable Home built actually governs the phone's mailbox.
    // Configuration, never discovery — same stance as sessionMode.
    retentionClass = "transient",
    clock = () => Date.now(),
    logger = console,
  } = {}) {
    super({ bus, logger });
    this.#clock = typeof clock === "function" ? clock : () => Date.now();
    if (retentionClass !== "transient" && retentionClass !== "standard") {
      throw new Error("ServerRuntimeService retentionClass must be \"transient\" or \"standard\"");
    }
    this.#retentionClass = retentionClass;
    if (!identity || typeof identity !== "object") {
      throw new Error("ServerRuntimeService requires identity");
    }
    if (!Array.isArray(uplinks) || uplinks.length === 0) {
      throw new Error("ServerRuntimeService requires uplinks");
    }
    this.#connected = false;
    this.#lastStatus = "";
    this.#offState = null;
    this.#offReconnect = null;
    this.#offMailboxPushBridge = null;
    this.#reconnectPromise = null;
    this.#connectPending = false;
    this.#connectInFlight = null;
    this.#hasAccountKey = Boolean(identity.privateKeyB64);
    // Tests inject a fake `sdk`; production wires via createRezClient.
    // peerLinkService is injected by ChatServerApp so the SDK can encrypt
    // outbound messages locally (Shape A) — see docs/CAPABILITY_MODEL.md.
    // expectedNodePublicKeyB64 ties the session-auth signature to the
    // launched node identity (docs/SECURITY_AUDIT.md CRITICAL-2): the SDK
    // refuses to authenticate against any node whose challenge claims a
    // different pubkey, even if its self-signature is valid.
    if (sessionMode !== "account-legacy" && sessionMode !== "claimant") {
      throw new Error("ServerRuntimeService sessionMode must be \"account-legacy\" or \"claimant\"");
    }
    this.#sessionMode = sessionMode;
    if (sessionMode === "claimant" && !inboxClaimant) {
      throw new Error("ServerRuntimeService claimant mode requires inboxClaimant (the session credential IS the claim key)");
    }
    const resolvedWsFactory = typeof wsFactory === "function"
      ? wsFactory
      : (typeof globalThis.WebSocket === "function" ? (url) => new globalThis.WebSocket(url) : null);
    if (!sdk && !resolvedWsFactory) {
      throw new Error("ServerRuntimeService requires sdk or a WebSocket implementation");
    }
    // F8: the data-plane client. Claimant mode authenticates with the inbox
    // claim key and gets the DATA-PLANE capability subset only (the SDK
    // constructs no account capabilities on a claimant client); the legacy
    // mode is the shipped account-authenticated client, byte-identical.
    this.#sdk = sdk || (sessionMode === "claimant"
      ? createRezClient({
        claimantIdentity: inboxClaimant.sessionClaimantIdentity(),
        uplinks,
        peerLinkService,
        clientVersion: "rez-chat-server/2.0",
        wsFactory: resolvedWsFactory,
        expectedNodePublicKeyB64: typeof expectedNodePublicKeyB64 === "string" ? expectedNodePublicKeyB64.trim() : "",
      })
      : createRezClient({
        identity,
        uplinks,
        peerLinkService,
        clientVersion: "rez-chat-server/2.0",
        wsFactory: resolvedWsFactory,
        expectedNodePublicKeyB64: typeof expectedNodePublicKeyB64 === "string" ? expectedNodePublicKeyB64.trim() : "",
      }));
    this.bus.runtime.sdk = this.#sdk;
    // Visible at the orchestration level: which session model this runtime is
    // on. The legacy value is the explicit marker that this deployment runs
    // the identity-bearing compatibility path — a green privacy suite must
    // never be read as covering a runtime reporting "account-legacy".
    this.bus.runtime.sessionMode = sessionMode;
    // Chat-server services that need direct access to the local PeerLinkService
    // (e.g. ServerInvitesService for create/accept, ServerConnectionService for
    // list/get) reach it via bus.runtime.peerLinks. This is the chat-side
    // canonical handle for the relocated peer-link logic.
    this.bus.runtime.peerLinks = peerLinkService;
    this.#inboxClaimant = inboxClaimant;
    this.bus.runtime.inboxClaimant = inboxClaimant;
    this._register("runtime", "connect", () => this.connect());
    this._register("runtime", "disconnect", () => this.disconnect());
    this._register("runtime", "ensureLive", () => this.ensureLive());
    this._register("runtime", "renewLeaseIfDue", () => this.renewLeaseIfDue());
    if (typeof this.#sdk.onPoolState === "function") {
      this.#offState = this.#sdk.onPoolState((state) => this.#handlePoolState(state));
    } else if (typeof this.#sdk.onState === "function") {
      this.#offState = this.#sdk.onState((state) => this.#handlePoolState(state));
    }
    const connectivity = this.#sdk && this.#sdk.connectivity ? this.#sdk.connectivity : null;
    if (connectivity && typeof connectivity.onReconnected === "function") {
      this.#offReconnect = connectivity.onReconnected(() => this.#restoreAfterReconnect());
    }
  }

  #handlePoolState(state) {
    const status = mapPoolPhaseToStatus(state && state.phase);
    if (!status) return;
    // A replacement transport has a fresh server-side session. Keep the app in
    // reconnecting state until the awaited onReconnected hook has replayed the
    // inbox claim and device binding for that session.
    if (status === "connected") return;
    if (status === this.#lastStatus) return;
    this.#lastStatus = status;
    const event = new ConnectionStateEvent({
      status,
      activeUplink: state && state.activeUplink ? String(state.activeUplink) : "",
      reason: state && state.reason ? String(state.reason) : "",
    });
    this._emit("connection.state", event);
  }

  get sdk() {
    return this.#sdk;
  }

  get sessionMode() {
    return this.#sessionMode;
  }

  get connected() {
    return this.#connected;
  }

  async connect() {
    if (this.#connected) return this.#sdk;
    // M1: connect is no longer called exactly once at boot — the pending-bind
    // completion (#restoreAfterReconnect) and the runtime.connect directive
    // can now race it, so concurrent callers share one in-flight attempt.
    if (this.#connectInFlight) return this.#connectInFlight;
    this.#connectInFlight = this.#runConnect();
    try {
      return await this.#connectInFlight;
    } finally {
      this.#connectInFlight = null;
    }
  }

  async #runConnect() {
    try {
      await this.#sdk.connect();
    } catch (err) {
      // M1 (offline-tolerant boot): a RETRYABLE failure means the home was
      // unreachable, not that it refused — the pool has already scheduled its
      // own background reconnect, so mark the bind PENDING and let the first
      // successful reconnect complete this exact sequence via
      // #restoreAfterReconnect. Terminal rejections and config errors carry no
      // retryable flag and keep failing loudly.
      if (err && err.retryable === true) {
        this.#connectPending = true;
      }
      throw err;
    }
    // Bridge the NEGOTIATED E6 multi-device fan-out capability (advertised by
    // the node in session.ready, now resolvable via getSessionInfo) onto the
    // runtime so ServerMessagesService's per-device sender fan-out gate can see
    // it (Audit R3 #3). Without this the node could flip its E6 gate at Slice 8
    // and the sender would still silently take the legacy single-device path.
    // Defaults false ⇒ fs / DO-relay / gate-closed pg nodes are unchanged.
    await this.#bindCurrentSession();
    // Single owner of the SDK's onMailboxDeposited subscription. Forwards
    // each push frame onto the chat bus so ServerEventService,
    // ServerPeerLinkProtocolService, and the InboxCatchupService all
    // dispatch through one canonical bus event.
    this.#offMailboxPushBridge = MailboxPushBridge.attach({
      sdk: this.#sdk,
      bus: this.bus,
      logger: this.logger,
    });
    this.#connected = true;
    this.#connectPending = false;
    this.#lastStatus = "connected";
    const event = new ConnectionStateEvent({ status: "connected" });
    this.bus.resolveReady.runtime();
    this._emit("runtime.connected", event);
    this._emit("connection.state", event);
    return this.#sdk;
  }

  async #bindCurrentSession() {
    // F8: the claimant data plane's session setup does claimant/mailbox work
    // ONLY. The legacy account path keeps the shipped sequence — its
    // device.bind and multi-device publication are account-control
    // operations, and running them inside connect is exactly the legacy
    // identity-bearing behavior the "account-legacy" label declares.
    if (this.#sessionMode === "claimant") {
      // F9: shared durable homes key their cursor model on device identity,
      // which a claimant session deliberately does not have. This is a
      // configuration error, refused loudly and NEVER downgraded — the
      // client does not switch modes because of what a node advertises.
      if (nodeAdvertisesDurableInbox(this.#sdk)) {
        throw new Error(
          "claimant session mode is not compatible with a shared durable home (F9): "
          + "this home's cursor model requires the legacy identity-bearing path — "
          + "configure sessionMode \"account-legacy\" for this deployment",
        );
      }
      this.bus.runtime.multiDeviceFanout = false;
      if (this.#inboxClaimant) {
        await this.#registerInboxClaim();
      }
      // M4 (plan §7b): `multiDeviceFanout=false` above is the per-SESSION
      // home capability — correct for a claimant session — but "does this
      // account have multiple active devices?" is a different, durable
      // question. Recompute it from roster + verified authority state (both
      // pure data plane) so a claimant session participates in sibling
      // convergence. Best-effort: an unestablishable answer leaves the flag
      // false and every outbound sibling round defers on its own.
      if (this.bus.functions && this.bus.functions["account-state"]
        && typeof this.bus.functions["account-state"].refreshAccountMultiDevice === "function") {
        await this._call("account-state", "refreshAccountMultiDevice", {}).catch((err) => {
          this.logger.error("ServerRuntimeService claimant bind: accountMultiDevice refresh failed (sibling sync will defer)", {
            message: err && err.message ? err.message : String(err),
          });
        });
      }
      this._emit("node.capabilities", new NodeCapabilitiesEvent({
        deviceLinking: false,
      }));
      return;
    }
    this.bus.runtime.multiDeviceFanout = nodeEnablesMultiDeviceFanout(this.#sdk);
    // Register chat-server's persistent inbox claim with the node. The node
    // persists the inboxId → claimantPublicKey mapping in its
    // InboxClaimRegistry and binds the WS session to this inbox. From this
    // point on, the session is authorized for owner-scoped ops on the inbox
    // via the session-binding shortcut, and the relay can verify cap chains
    // rooted under this claim for cross-account deposits.
    if (this.#inboxClaimant) {
      await this.#registerInboxClaim();
      // S2.5 Slice 5: present this device's proven key to the home so the durable
      // cursor keys on the SIGNED self-cert deviceId. Best-effort + gated on the
      // node advertising `durableInbox` — a no-op against fs/DO-relay nodes, so
      // the shipped single-device path is byte-for-byte unchanged. E6 closed.
      await this.#registerDeviceBind();
      // S2.5 S12: with the E6 fan-out gate OPEN, self-publish this device's bundle
      // to the home and (re)publish the account's multi-device set to every peer,
      // so senders can resolve it. Gate-closed / non-durable nodes never reach here
      // (multiDeviceFanout false) — the shipped path is byte-for-byte unchanged.
      //
      // DEVICE ACTIVATION (plans/DEVICE_ACTIVATION_PLAN.md): bundle
      // publication is the ONLY externally visible commit of the activation
      // transaction, so for a DELEGATED device it is SEQUENCED behind
      // bootstrap completeness. The activation service reconciles the journal
      // with the network's observable truth and answers whether this connect
      // may publish; a device it defers stays invisible to senders until the
      // baseline marker commits it (READY → ACTIVE). Primary devices and
      // pre-plan enrollments (no journal / already in the served set) publish
      // exactly as today. Guarded on the directive so a standalone runtime
      // service (tests, minimal embeddings) keeps the shipped behavior.
      if (this.bus.runtime.multiDeviceFanout === true) {
        let publish = true;
        const activation = this.bus.functions && this.bus.functions["device-activation"];
        if (!this.#hasAccountKey && activation && typeof activation.sync === "function") {
          const gate = await this._call("device-activation", "sync", {});
          publish = !gate || gate.publish !== false;
        }
        if (publish) {
          await this.#publishMultiDeviceSet();
        }
      }
    }
    // MessageCommitAck (plan §3): reconnect is an event-triggered wakeup for
    // the durable pending-commit retry loop — anything whose window elapsed
    // while offline re-fans-out now. Best-effort; guarded on the directive so
    // standalone runtime services (tests, minimal embeddings) are unchanged.
    if (this.bus.functions && this.bus.functions["message.commit"]) {
      await this._call("message.commit", "sweep", {}).catch((err) => {
        this.logger.error("ServerRuntimeService reconnect pending-commit sweep failed", {
          message: err && err.message ? err.message : String(err),
        });
      });
    }
    // Publish what the HOME can do, so the UI can decline to OFFER operations it
    // cannot perform (rez-chat#3). Read from the same bound session as the
    // fan-out gate above, so the two can never disagree about which node
    // answered.
    //
    // LAST, deliberately: everything above can throw (a replacement transport
    // whose inbox claim cannot be rebound rejects here and the connection goes
    // offline). Announcing earlier would advertise a capability for a session
    // that never became usable, and the UI would keep offering device linking
    // against a home it is not actually attached to. On that failure path
    // nothing is emitted and SessionService clears the capability on
    // runtime.disconnected.
    this._emit("node.capabilities", new NodeCapabilitiesEvent({
      deviceLinking: nodeSupportsDeviceLinking(this.#sdk),
    }));
  }

  /**
   * M2 (plans/MOBILE_LIFECYCLE_ADAPTER_PLAN.md): the app-level liveness
   * kick. Wake paths call this instead of trusting suspension-frozen backoff
   * timers.
   *   - First connect incomplete (offline boot, M1) or never attempted →
   *     run the full connect, bind included. A still-offline failure
   *     rethrows (retryable) so a wake sequence can short-circuit and
   *     report.
   *   - Pool reports reconnecting/offline → connectivity.connectNow():
   *     cancel the backoff wait, one attempt serialized with the pool's own
   *     machinery; the awaited restoration hook replays the bind before it
   *     resolves.
   *   - Otherwise → no-op. The caller's next round-trip (the drain) is the
   *     liveness probe: a zombie socket surfaces there as a transport error,
   *     which drives the normal reconnect machinery — no duplicate
   *     heartbeat logic here.
   */
  async ensureLive() {
    if (!this.#connected) {
      await this.connect();
      return { live: true, action: "connected" };
    }
    if (this.#lastStatus === "connected") {
      return { live: true, action: "none" };
    }
    const connectivity = this.#sdk && this.#sdk.connectivity ? this.#sdk.connectivity : null;
    if (!connectivity || typeof connectivity.connectNow !== "function") {
      throw new Error("ServerRuntimeService.ensureLive: sdk.connectivity.connectNow is unavailable");
    }
    await connectivity.connectNow();
    return { live: true, action: "reconnected" };
  }

  async #restoreAfterReconnect() {
    if (!this.#connected) {
      // M1 (offline-tolerant boot): the FIRST connect never completed, but the
      // pool's background reconnect just found the home. Run the full connect
      // sequence now — bind, push bridge, ready gate — so an offline boot
      // heals without a process restart. A throw here propagates into the
      // pool's restoration hook, which drops back to offline and reschedules,
      // so an interrupted completion self-heals on the next reconnect.
      if (!this.#connectPending) return;
      return this.connect();
    }
    if (this.#reconnectPromise) return this.#reconnectPromise;
    this.#reconnectPromise = (async () => {
      await this.#bindCurrentSession();
      this.#lastStatus = "connected";
      const event = new ConnectionStateEvent({ status: "connected" });
      this._emit("runtime.connected", event);
      this._emit("connection.state", event);
    })();
    try {
      await this.#reconnectPromise;
    } catch (err) {
      this.#lastStatus = "offline";
      const reason = err && err.message ? err.message : "session restore failed";
      this._emit("connection.state", new ConnectionStateEvent({ status: "offline", reason }));
      this.logger.error("[ServerRuntimeService] reconnect session restore failed: " + reason);
      throw err;
    } finally {
      this.#reconnectPromise = null;
    }
  }

  /**
   * M3 (plans/MOBILE_LIFECYCLE_ADAPTER_PLAN.md): wake-time lease renewal
   * derived from durable state + now — never from a timer that fired.
   * Due when `remaining <= TTL/2` (pin 2: the exact boundary renews).
   * Renewal IS the idempotent claim/reattest round-trip every reconnect
   * already performs; success records the newly-ACCEPTED lease (pin 1,
   * inside #registerInboxClaim), and a failed attempt throws having recorded
   * nothing, leaving the previous durable lease state intact (pin 3).
   * Missing lease state — a pre-M3 record or an earlier failed persist —
   * derives as DUE: renewing is the safe direction and repopulates it.
   */
  async renewLeaseIfDue() {
    if (!this.#inboxClaimant) return { renewed: false, reason: "no-claimant" };
    if (!this.#connected) return { renewed: false, reason: "not-connected" };
    const claimStore = this.#inboxClaimant.claimStore;
    if (!claimStore || typeof claimStore.leaseState !== "function") {
      return { renewed: false, reason: "lease-state-unsupported" };
    }
    const inboxId = this.#inboxClaimant.inboxId;
    const lease = claimStore.leaseState(inboxId);
    if (lease) {
      const ttlMs = Number(lease.expiresAtMs) - Number(lease.issuedAtMs);
      const remainingMs = Number(lease.expiresAtMs) - this.#clock();
      // Explicit NaN handling (the frozen `NaN >= x is false` lesson): a
      // non-finite window must derive as DUE, never silently as "not due".
      const due = !Number.isFinite(ttlMs) || !Number.isFinite(remainingMs)
        || remainingMs <= ttlMs / 2;
      if (!due) {
        return { renewed: false, reason: "not-due", expiresAtMs: lease.expiresAtMs };
      }
    }
    await this.#registerInboxClaim();
    const accepted = claimStore.leaseState(inboxId);
    return { renewed: true, expiresAtMs: accepted ? accepted.expiresAtMs : null };
  }

  async #registerInboxClaim({ remintAttempted = false } = {}) {
    const processRef = typeof process !== "undefined" ? process : null;
    const debug = Boolean(processRef && processRef.env && processRef.env.REZ_INBOX_DEBUG === "1");
    const claimStore = this.#inboxClaimant.claimStore;
    const inboxId = this.#inboxClaimant.inboxId;
    if (debug) console.log("[INBOX-DEBUG] ServerRuntimeService.#registerInboxClaim start", { inboxId });
    try {
      // The claim round-trip itself is the SSOT helper (P1.3b) — the portable
      // establishment path sends the same bytes through the same code. M7: ONE
      // clock. The renewal threshold (renewLeaseIfDue) derives "due" from the
      // runtime's injected clock, so the lease window this bind ISSUES must
      // come from the same clock — a split (issue on Date.now, decide on
      // #clock) would let the two disagree about the same lease. Production is
      // byte-identical (the default clock IS Date.now). Lease recording (M3
      // pin 1: acceptance seam only) happens inside the helper.
      await registerInboxClaimOnSession({
        sdk: this.#sdk,
        claimStore,
        inboxId,
        retentionClass: this.#retentionClass,
        clock: this.#clock,
        logger: this.logger,
      });
    } catch (err) {
      if (debug) console.error("[INBOX-DEBUG] ServerRuntimeService.#registerInboxClaim INBOX_CLAIM rejected",
        { inboxId, errCode: err && err.code, errMessage: err && err.message ? err.message : err });
      // M6 (plan §7e): wake-after-reclamation recovery. Re-mint requires
      // PROVIDER EVIDENCE, never local arithmetic — the typed INBOX_CLOSED
      // detail must say reason "reclaimed" AND name a finalGeneration that
      // exactly matches our stored generation (remintGeneration re-checks
      // and throws REMINT_GENERATION_CONFLICT on disagreement — surfaced,
      // never guessed past). "terminal" is intent death and never recovers.
      // Single retry: a second refusal after a successful re-mint is a real
      // fault, not a loop invitation.
      const detail = err && err.detail && typeof err.detail === "object" ? err.detail : null;
      const reclaimed = Boolean(err && err.code === "INBOX_CLOSED"
        && detail && detail.closeReason === "reclaimed"
        && Number.isInteger(detail.finalGeneration));
      if (!reclaimed || remintAttempted || typeof claimStore.remintGeneration !== "function") {
        throw err;
      }
      const reminted = await claimStore.remintGeneration({
        inboxId,
        finalGeneration: detail.finalGeneration,
      });
      // DISTINCT from renewal-in-grace (frozen §7b): renewal is transparent
      // recovery with mail intact; re-mint is ADDRESS recovery — anything
      // buffered during the dark period is gone, and the UI must be able to
      // say so. Loud, user-visible, its own event — never reported as a
      // "mailbox renewed".
      this.logger.error("ServerRuntimeService: inbox was reclaimed while this device was offline; "
        + "re-minted generation " + reminted.toGeneration + " (address preserved; "
        + "messages buffered during the dark period are gone)", { inboxId });
      this._emit("mailbox.remint", {
        inboxId,
        fromGeneration: reminted.fromGeneration,
        toGeneration: reminted.toGeneration,
      });
      return this.#registerInboxClaim({ remintAttempted: true });
    }
    if (debug) console.log("[INBOX-DEBUG] ServerRuntimeService.#registerInboxClaim INBOX_CLAIM accepted", { inboxId });
  }

  /**
   * Present this device's proven key to the home (S2.5 Slice 5). The durable
   * cursor then keys on the SIGNED self-certifying deviceId rather than the
   * unsigned SessionHello string.
   *
   * Gated on the node advertising `durableInbox` (DO relays / fs nodes don't, so
   * this is a no-op there — the device.bind handler would only answer
   * SERVICE_UNAVAILABLE).
   *
   * Readiness semantics depend on the node's E6 gate (Audit R2 #6):
   *   - Gate CLOSED (default; node does NOT advertise `multiDeviceFanout`): the
   *     inbox.claim already created the durable cursor keyed on the session
   *     deviceId, so device.bind only BACKFILLS the proven key. A failure is
   *     harmless (the cursor exists) ⇒ best-effort, logged not thrown. This is
   *     the shipped single-device path — byte-for-byte unchanged.
   *   - Gate OPEN (node advertises `multiDeviceFanout`): the claim NO-OPS the
   *     cursor, so device.bind is the ONLY way to obtain one. A client that
   *     connected but could not bind has NO usable cursor and would later fail
   *     with DEVICE_NOT_REGISTERED. So bind becomes a READINESS REQUIREMENT: a
   *     missing device key or a failed bind THROWS, failing connect() rather than
   *     reporting a ready connection with no cursor.
   * Since the gate stays CLOSED until Slice 8, the throwing path is currently
   * inert in production — no regression to the shipped delivery path.
   */
  async #registerDeviceBind() {
    const sdk = this.#sdk;
    if (!nodeAdvertisesDurableInbox(sdk)) return;
    const gateOpen = nodeRequiresProvenDevice(sdk);

    const hasDeviceKey = sdk && sdk.identity && sdk.devices
      && typeof sdk.identity.getDeviceKeyPublicKeyB64 === "function"
      && Boolean(sdk.identity.getDeviceKeyPublicKeyB64());
    if (!hasDeviceKey) {
      if (gateOpen) {
        throw new Error(
          "ServerRuntimeService: node has multi-device fan-out enabled but this client "
          + "has no device key to prove via device.bind — refusing to report ready without a durable cursor",
        );
      }
      return; // gate closed: the legacy claim cursor suffices
    }

    const inboxId = this.#inboxClaimant.inboxId;
    try {
      // S10: a DELEGATED identity (no account private key) sends the binding
      // ONLY — its session cert chain IS the registration (S8 node handler
      // dual-mode). Building the account-signed DeviceRegistrationV1 requires
      // B, so only a primary can (and must) attach it.
      const deviceRegistration = this.#hasAccountKey
        ? await sdk.identity.buildDeviceRegistration()
        : null;
      const deviceInboxBinding = await sdk.identity.buildDeviceInboxBinding({ inboxId });
      await sdk.devices.bind({ deviceRegistration, deviceInboxBinding });
    } catch (err) {
      this.logger.error("ServerRuntimeService.#registerDeviceBind device.bind failed", {
        inboxId,
        code: err && err.code ? err.code : null,
        message: err && err.message ? err.message : String(err),
      });
      // Gate OPEN: no proven bind ⇒ no cursor ⇒ not ready. Propagate so connect()
      // fails instead of advertising a connection that cannot receive durable mail.
      if (gateOpen) throw err;
      // Gate CLOSED: best-effort backfill; the claim cursor already works.
    }
  }

  // S2.5 S12: publish this device's bundle to the home + (re)publish the account's
  // multi-device set to every peer, once the E6 gate is known open. Best-effort —
  // a publish failure must not fail connect() (the account can still send/receive;
  // the set republishes on the next device change or reconnect).
  async #publishMultiDeviceSet() {
    try {
      await this._call("device-set", "publishOwnBundle", {});
      await this._call("device-set", "republishToAllPeers", {});
      // M4: this connect IS an authenticated account-plane touch — refresh
      // the durable device roster from the home's ACTIVE aggregate so
      // claimant wakes (this device's or a sibling installation sharing the
      // storage) have a current membership snapshot to compose with verified
      // authority state.
      if (this.bus.functions && this.bus.functions["device-set"]
        && typeof this.bus.functions["device-set"].snapshotRoster === "function") {
        await this._call("device-set", "snapshotRoster", {});
      }
      // AF6b: retry any cross-device account-state deltas that failed to dispatch
      // while this device was offline (idempotent at the sibling).
      await this._call("account-state", "flushPending", {});
      // FU4: throttled full-state anti-entropy so a sibling that missed deltas
      // entirely (offline past home retention) converges on (re)connect.
      await this._call("account-state", "reconcile", {});
      // AE-2: sibling message anti-entropy on (re)connect — announce thread
      // digests so the immutable OriginalMessage fact logs converge
      // (throttled inside the service; no-op when not multi-device).
      if (this.bus.functions && this.bus.functions["sibling-sync"]) {
        await this._call("sibling-sync", "syncAll", {});
      }
    } catch (err) {
      this.logger.error("ServerRuntimeService.#publishMultiDeviceSet failed", {
        message: err && err.message ? err.message : String(err),
      });
    }
  }

  async disconnect() {
    if (!this.#connected) {
      // M1: an offline boot may have left the first connect PENDING (armed to
      // complete on the pool's next background reconnect). An explicit
      // disconnect stands that down so a stopped runtime can never late-bind.
      this.#connectPending = false;
      return;
    }
    if (typeof this.#offMailboxPushBridge === "function") {
      try {
        this.#offMailboxPushBridge();
      } catch (err) {
        this.logger.error("[ServerRuntimeService] mailbox push bridge detach failed: " + (err && err.message ? err.message : err));
      }
      this.#offMailboxPushBridge = null;
    }
    await this.#sdk.close();
    this.#connected = false;
    this.#lastStatus = "disconnected";
    const event = new ConnectionStateEvent({ status: "disconnected" });
    this._emit("runtime.disconnected", event);
    this._emit("connection.state", event);
  }

  async stop() {
    if (typeof this.#offReconnect === "function") {
      try { this.#offReconnect(); } catch { /* ignore */ }
      this.#offReconnect = null;
    }
    if (typeof this.#offState === "function") {
      try { this.#offState(); } catch { /* ignore */ }
      this.#offState = null;
    }
    await this.disconnect().catch((err) => {
      this.logger.error("[ServerRuntimeService] disconnect during teardown failed", err && err.message ? err.message : err);
      this._emit("app.error", { source: "ServerRuntimeService", message: "disconnect during teardown failed", severity: "info", err });
    });
    await super.stop();
  }
}
