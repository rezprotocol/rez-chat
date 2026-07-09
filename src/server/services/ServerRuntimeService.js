import { WebSocket } from "ws";
import { createRezClient, REZ_CONTRACT_TYPES } from "@rezprotocol/sdk/client";
import { ConnectionStateEvent } from "../../records/index.js";
import { BaseServerService } from "../base/BaseServerService.js";
import { MailboxPushBridge } from "../runtime/MailboxPushBridge.js";
import { nodeAdvertisesDurableInbox, nodeRequiresProvenDevice, nodeEnablesMultiDeviceFanout } from "../inbox/durableMode.js";

const T = REZ_CONTRACT_TYPES;

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
  #offMailboxPushBridge;

  #inboxClaimant;

  // S10: whether this identity holds the account root (B-sign private key).
  // A DELEGATED identity binds with its device-signed inbox binding only —
  // the session cert chain is its registration.
  #hasAccountKey;

  constructor({
    bus,
    identity,
    uplinks,
    sdk = null,
    peerLinkService = null,
    inboxClaimant = null,
    expectedNodePublicKeyB64 = "",
    logger = console,
  } = {}) {
    super({ bus, logger });
    if (!identity || typeof identity !== "object") {
      throw new Error("ServerRuntimeService requires identity");
    }
    if (!Array.isArray(uplinks) || uplinks.length === 0) {
      throw new Error("ServerRuntimeService requires uplinks");
    }
    this.#connected = false;
    this.#lastStatus = "";
    this.#offState = null;
    this.#offMailboxPushBridge = null;
    this.#hasAccountKey = Boolean(identity.privateKeyB64);
    // Tests inject a fake `sdk`; production wires via createRezClient.
    // peerLinkService is injected by ChatServerApp so the SDK can encrypt
    // outbound messages locally (Shape A) — see docs/CAPABILITY_MODEL.md.
    // expectedNodePublicKeyB64 ties the session-auth signature to the
    // launched node identity (docs/SECURITY_AUDIT.md CRITICAL-2): the SDK
    // refuses to authenticate against any node whose challenge claims a
    // different pubkey, even if its self-signature is valid.
    this.#sdk = sdk || createRezClient({
      identity,
      uplinks,
      peerLinkService,
      clientVersion: "rez-chat-server/2.0",
      wsFactory: (url) => new WebSocket(url),
      expectedNodePublicKeyB64: typeof expectedNodePublicKeyB64 === "string" ? expectedNodePublicKeyB64.trim() : "",
    });
    this.bus.runtime.sdk = this.#sdk;
    // Chat-server services that need direct access to the local PeerLinkService
    // (e.g. ServerInvitesService for create/accept, ServerConnectionService for
    // list/get) reach it via bus.runtime.peerLinks. This is the chat-side
    // canonical handle for the relocated peer-link logic.
    this.bus.runtime.peerLinks = peerLinkService;
    this.#inboxClaimant = inboxClaimant;
    this.bus.runtime.inboxClaimant = inboxClaimant;
    this._register("runtime", "connect", () => this.connect());
    this._register("runtime", "disconnect", () => this.disconnect());
    if (typeof this.#sdk.onState === "function") {
      this.#offState = this.#sdk.onState((state) => this.#handlePoolState(state));
    }
  }

  #handlePoolState(state) {
    const status = mapPoolPhaseToStatus(state && state.phase);
    if (!status) return;
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

  get connected() {
    return this.#connected;
  }

  async connect() {
    if (this.#connected) return this.#sdk;
    await this.#sdk.connect();
    // Bridge the NEGOTIATED E6 multi-device fan-out capability (advertised by
    // the node in session.ready, now resolvable via getSessionInfo) onto the
    // runtime so ServerMessagesService's per-device sender fan-out gate can see
    // it (Audit R3 #3). Without this the node could flip its E6 gate at Slice 8
    // and the sender would still silently take the legacy single-device path.
    // Defaults false ⇒ fs / DO-relay / gate-closed pg nodes are unchanged.
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
      if (this.bus.runtime.multiDeviceFanout === true) {
        await this.#publishMultiDeviceSet();
      }
    }
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
    this.#lastStatus = "connected";
    const event = new ConnectionStateEvent({ status: "connected" });
    this.bus.resolveReady.runtime();
    this._emit("runtime.connected", event);
    this._emit("connection.state", event);
    return this.#sdk;
  }

  async #registerInboxClaim() {
    const debug = process.env.REZ_INBOX_DEBUG === "1";
    const claimStore = this.#inboxClaimant.claimStore;
    const inboxId = this.#inboxClaimant.inboxId;
    const nodeIdentity = this.#resolveNodeIdentity();
    if (debug) console.log("[INBOX-DEBUG] ServerRuntimeService.#registerInboxClaim start",
      { inboxId, nodeKeyId: nodeIdentity.nodeKeyId, relayKeyId: nodeIdentity.relayKeyId });
    const attestation = await claimStore.createReattestation(inboxId);
    const delegation = await claimStore.createNodeDelegation({
      inboxId,
      nodeKeyId: nodeIdentity.nodeKeyId,
      nodePublicKeyB64: nodeIdentity.nodePublicKeyB64,
      relayKeyId: nodeIdentity.relayKeyId,
    });
    if (debug) console.log("[INBOX-DEBUG] ServerRuntimeService.#registerInboxClaim built delegation",
      { inboxId, claimantPublicKeyB64: attestation.claimantPublicKeyB64, issuedAtMs: delegation.issuedAtMs, expiresAtMs: delegation.expiresAtMs });
    try {
      await this.#sdk.sendRequest({
        type: T.INBOX_CLAIM,
        body: {
          inboxId: attestation.inboxId,
          claimantPublicKeyB64: attestation.claimantPublicKeyB64,
          claimedAtMs: attestation.claimedAtMs,
          signatureB64: attestation.claimSignatureB64,
          nodeDelegation: {
            nodeKeyId: delegation.nodeKeyId,
            nodePublicKeyB64: delegation.nodePublicKeyB64,
            relayKeyId: delegation.relayKeyId,
            issuedAtMs: delegation.issuedAtMs,
            expiresAtMs: delegation.expiresAtMs,
            delegationSigB64: delegation.delegationSigB64,
          },
        },
        expectedResponseType: T.INBOX_CLAIM_RES,
      });
    } catch (err) {
      if (debug) console.error("[INBOX-DEBUG] ServerRuntimeService.#registerInboxClaim INBOX_CLAIM rejected",
        { inboxId, errCode: err && err.code, errMessage: err && err.message ? err.message : err });
      throw err;
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
      // AF6b: retry any cross-device account-state deltas that failed to dispatch
      // while this device was offline (idempotent at the sibling).
      await this._call("account-state", "flushPending", {});
    } catch (err) {
      this.logger.error("ServerRuntimeService.#publishMultiDeviceSet failed", {
        message: err && err.message ? err.message : String(err),
      });
    }
  }

  #resolveNodeIdentity() {
    const info = typeof this.#sdk.getSessionInfo === "function" ? this.#sdk.getSessionInfo() : null;
    const nodeKeyId = info && typeof info.nodeKeyId === "string" ? info.nodeKeyId.trim() : "";
    const nodePublicKeyB64 = info && typeof info.nodePublicKeyB64 === "string" ? info.nodePublicKeyB64.trim() : "";
    const relayKeyId = info && typeof info.relayKeyId === "string" ? info.relayKeyId.trim() : "";
    if (!nodeKeyId || !nodePublicKeyB64 || !relayKeyId) {
      throw new Error("ServerRuntimeService: node identity unavailable from SDK session");
    }
    return { nodeKeyId, nodePublicKeyB64, relayKeyId };
  }

  async disconnect() {
    if (!this.#connected) return;
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
