import { WebSocket } from "ws";
import { createRezClient, REZ_CONTRACT_TYPES } from "@rezprotocol/sdk/client";
import { ConnectionStateEvent } from "../../records/index.js";
import { BaseServerService } from "../base/BaseServerService.js";
import { MailboxPushBridge } from "../runtime/MailboxPushBridge.js";

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
    // Register chat-server's persistent inbox claim with the node. The node
    // persists the inboxId → claimantPublicKey mapping in its
    // InboxClaimRegistry and binds the WS session to this inbox. From this
    // point on, the session is authorized for owner-scoped ops on the inbox
    // via the session-binding shortcut, and the relay can verify cap chains
    // rooted under this claim for cross-account deposits.
    if (this.#inboxClaimant) {
      await this.#registerInboxClaim();
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
