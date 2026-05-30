import {
  InviteAcceptParams,
  InviteAcceptResult,
  InviteCreateParams,
  InviteCreateResult,
} from "../../records/index.js";
import { BaseServerService } from "../base/BaseServerService.js";
import {
  bytesToBase64,
  encodeInviteCodeV2,
  isInviteCodeV2,
  parseInviteCodeV2,
} from "@rezprotocol/sdk/client";

const CLAIM_RES_TIMEOUT_MS = 10_000;

/**
 * ServerInvitesService — chat-server-side peer-link invite create + accept
 * (Shape A). Uses the local PeerLinkService (`bus.runtime.peerLinks`) so
 * records land in chat-server storage. Cross-network invite resolution uses
 * `bus.runtime.claimWaiter` (owned by ServerPeerLinkProtocolService).
 */
export class ServerInvitesService extends BaseServerService {
  constructor({ bus, logger = console } = {}) {
    super({ bus, logger });
    this._register("invite", "create", (payload) => this.createInvite(payload));
    this._register("invite", "accept", (payload) => this.acceptInvite(payload));
  }

  async createInvite(payload = {}) {
    const params = this._coerceParams(payload, InviteCreateParams);
    const peerLinks = this._peerLinks();
    // chat-server uses its persistent claimed inbox (registered via inbox.claim
    // during runtime.connect) — NOT the SDK session's ephemeral inbox. This is
    // the inboxId every cap chain anchors against.
    const inboxClaimant = this.bus.runtime && this.bus.runtime.inboxClaimant
      ? this.bus.runtime.inboxClaimant : null;
    if (!inboxClaimant) {
      throw new Error("createInvite: chat-server requires bus.runtime.inboxClaimant");
    }
    const ownInboxId = inboxClaimant.inboxId;

    const kind = params.kind === "group" ? "group" : "direct";
    const groupId = kind === "group" && typeof params.groupId === "string" && params.groupId.trim() ? params.groupId.trim() : null;
    const maxUses = Number.isInteger(params.maxUses) && params.maxUses > 0 ? params.maxUses : 1;
    const expiresInDays = Number.isInteger(params.expiresInDays) && params.expiresInDays > 0 ? params.expiresInDays : 7;
    const creatorDisplayName = typeof params.creatorDisplayName === "string" && params.creatorDisplayName.trim()
      ? params.creatorDisplayName.trim() : null;
    const title = kind === "group" && typeof params.title === "string" && params.title.trim()
      ? params.title.trim() : null;

    const result = await peerLinks.createInvite({
      creatorDisplayName,
      kind,
      groupId,
      title,
      maxUses,
      expiresAtMs: Date.now() + expiresInDays * 24 * 60 * 60 * 1000,
      peerInboxId: ownInboxId,
    });

    const inviteCode = encodeInviteCodeV2({
      inviteId: result.inviteId,
      creatorInboxId: ownInboxId,
    });

    return new InviteCreateResult({
      peerLinkId: result.peerLinkId,
      inviteId: result.inviteId,
      inviteCode,
      state: result.state,
      expiresAtMs: result.expiresAtMs,
      maxUses: result.maxUses,
    });
  }

  async acceptInvite(payload = {}) {
    const params = this._coerceParams(payload, InviteAcceptParams);
    const peerLinks = this._peerLinks();
    const sdk = this._sdk();

    const inviteCode = typeof params.inviteCode === "string" ? params.inviteCode.trim() : "";
    if (!inviteCode) {
      throw new Error("acceptInvite: inviteCode required");
    }
    if (!isInviteCodeV2(inviteCode)) {
      throw new Error("acceptInvite: only v2 short codes are supported");
    }
    const { inviteId, creatorInboxId } = parseInviteCodeV2(inviteCode);

    // 1. Resolve envelope: local-first (atomic spend), then cross-network
    // claim (the remote inviter spends inside its claim.req handler). Both
    // paths now enforce maxUses — local via claimInviteAsRemote directly,
    // remote via claim.res error propagation through _resolveClaimWaiter.
    const ownerAccountId = peerLinks.ownerAccountId;
    let envelopeData = null;
    const localRecord = await peerLinks.getStoredInviteEnvelope(ownerAccountId, inviteId);
    if (localRecord) {
      envelopeData = await peerLinks.claimInviteAsRemote({
        ownerAccountId, inviteId,
      });
    } else {
      envelopeData = await this._claimRemoteInviteEnvelope({
        sdk, inviteId, creatorInboxId, replyInboxId: this._ownInboxId(),
      });
    }
    if (!envelopeData || !envelopeData.envelope) {
      const err = new Error("acceptInvite: invite envelope not found");
      err.code = "INVITE_NOT_FOUND";
      throw err;
    }

    const acceptorDisplayName = typeof params.acceptorDisplayName === "string" && params.acceptorDisplayName.trim()
      ? params.acceptorDisplayName.trim() : null;

    // 2. Run X3DH initiator + send handshake to creator's inbox.
    const result = await peerLinks.acceptInvite({
      envelope: envelopeData.envelope,
      signatureB64: envelopeData.signatureB64,
      acceptorAccountId: ownerAccountId,
      acceptorDisplayName,
      senderInboxId: this._ownInboxId(),
      sendHandshake: async ({ deliverInboxId, handshakePacket }) => {
        const target = String(deliverInboxId || "").trim();
        if (!target) {
          const err = new Error("acceptInvite sendHandshake: no target inbox");
          err.code = "UNREACHABLE";
          throw err;
        }
        const objectId = "hs_" + Date.now() + "_" + Math.random().toString(36).slice(2, 10);
        await sdk.mailbox.deposit({
          mailboxId: target,
          objectId,
          ciphertextB64: bytesToBase64(handshakePacket.toBytes()),
          metadata: {},
        });
        return { packetId: objectId };
      },
    });

    // 3. Surface result + ensure chat-domain state.
    const snapshot = result && result.snapshot ? result.snapshot : {};
    const peerAccountId = snapshot.localAccountId === ownerAccountId
      ? snapshot.peerAccountId
      : snapshot.localAccountId;
    const envelopeObj = envelopeData.envelope || {};
    const remoteDisplayName = typeof envelopeObj.creatorDisplayName === "string"
      ? envelopeObj.creatorDisplayName.trim() : "";
    // groupId comes from the SIGNED invite envelope (the only authoritative
    // source). peer-link snapshots no longer carry group context.
    const groupId = typeof envelopeObj.groupId === "string" && envelopeObj.groupId.trim()
      ? envelopeObj.groupId.trim() : null;
    const peerInboxId = typeof snapshot.peerInboxId === "string" ? snapshot.peerInboxId.trim() || null : null;
    const title = typeof envelopeObj.title === "string" && envelopeObj.title.trim() ? envelopeObj.title.trim() : null;

    if (peerAccountId && this.bus.services.contacts) {
      await this.bus.services.contacts.ensureActiveContact({
        accountId: peerAccountId,
        displayName: remoteDisplayName,
      }).catch((err) => {
        this.logger.error("[ServerInvitesService] contact ensure failed", err && err.message ? err.message : err);
        this._emit("app.error", { source: "ServerInvitesService", message: "contact ensure failed", severity: "warn", err });
      });
    }

    if (groupId) {
      await this.bus.services.threads.ensureGroupThread({
        groupId,
        peerAccountId,
        createdAtMs: Date.now(),
        title,
      }).catch((err) => {
        this.logger.error("[ServerInvitesService] group thread ensure failed", err && err.message ? err.message : err);
        this._emit("app.error", { source: "ServerInvitesService", message: "group thread ensure failed", severity: "warn", err });
      });
      const groupThreadId = this.bus.services.threads.groupThreadId(groupId);
      if (groupThreadId && typeof this.bus.services.threads.emitThreadIndexUpdated === "function") {
        this.bus.services.threads.emitThreadIndexUpdated({
          threadId: groupThreadId,
          lastActivityAtMs: Date.now(),
          lastMessagePreview: title || "Joined group",
          unreadCount: 0,
        });
      }
      // Announce ourselves to the inviter (and, via shape-B forward, the
      // rest of the group) using the envelope's signed inviteId as proof.
      // This is the canonical channel by which the inviter learns we
      // accepted; the peer-link snapshot is plumbing and does NOT carry
      // group membership semantics. Idempotent on the inviter side.
      const envelopeInviteId = typeof envelopeObj.inviteId === "string" ? envelopeObj.inviteId.trim() : "";
      const groupsService = this.bus.services && this.bus.services.groups;
      if (envelopeInviteId && peerAccountId && groupsService
          && typeof groupsService.sendMemberJoinOp === "function") {
        await groupsService.sendMemberJoinOp({
          groupId,
          inviterAccountId: peerAccountId,
          inviteId: envelopeInviteId,
          displayName: params.acceptorDisplayName || "",
        }).catch((err) => {
          this.logger.error("[ServerInvitesService] member.join send failed",
            err && err.message ? err.message : err);
        });
      }
      return new InviteAcceptResult({
        peerLinkId: snapshot.peerLinkId,
        state: snapshot.state,
        peerAccountId,
        remoteDisplayName,
        sessionState: snapshot.sessionState,
        peerInboxId: peerInboxId,
        groupId,
        groupThreadId,
      });
    }

    let threadId = null;
    if (peerAccountId && this.bus.services.threads
        && typeof this.bus.services.threads.directThreadIdForPeerLink === "function") {
      threadId = this.bus.services.threads.directThreadIdForPeerLink(snapshot.peerLinkId, peerAccountId);
    }
    if (threadId) {
      await this.bus.services.threads.ensureDirectThread({
        threadId,
        peerAccountId,
        peerInboxId,
        createdAtMs: Date.now(),
      }).catch((err) => {
        this.logger.error("[ServerInvitesService] direct thread ensure failed", err && err.message ? err.message : err);
        this._emit("app.error", { source: "ServerInvitesService", message: "direct thread ensure failed", severity: "warn", err });
      });
      const indexRecord = await this.bus.stores.threadIndex.upsertFromMessage({
        threadId,
        messageId: null,
        ts: Date.now(),
        preview: peerInboxId ? "Connected" : "[peer-link] warn|PENDING|Waiting for peer link",
      }).catch((err) => {
        this.logger.error("[ServerInvitesService] direct thread index update failed", err && err.message ? err.message : err);
        this._emit("app.error", { source: "ServerInvitesService", message: "direct thread index update failed", severity: "warn", err });
        return null;
      });
      if (indexRecord && this.bus.services.threads
          && typeof this.bus.services.threads.emitThreadIndexUpdated === "function") {
        this.bus.services.threads.emitThreadIndexUpdated(indexRecord);
      }
    }

    return new InviteAcceptResult({
      peerLinkId: snapshot.peerLinkId,
      state: snapshot.state,
      peerAccountId,
      remoteDisplayName,
      sessionState: snapshot.sessionState,
      peerInboxId: peerInboxId,
      threadId,
    });
  }

  // --- helpers ---

  _peerLinks() {
    const peerLinks = this.bus.runtime && this.bus.runtime.peerLinks ? this.bus.runtime.peerLinks : null;
    if (!peerLinks) {
      throw new Error("ServerInvitesService requires bus.runtime.peerLinks (local PeerLinkService)");
    }
    return peerLinks;
  }

  _sdk() {
    const sdk = this.bus.runtime && this.bus.runtime.sdk ? this.bus.runtime.sdk : null;
    if (!sdk) throw new Error("ServerInvitesService requires bus.runtime.sdk");
    return sdk;
  }

  _ownInboxId() {
    const claimant = this.bus.runtime && this.bus.runtime.inboxClaimant
      ? this.bus.runtime.inboxClaimant : null;
    return claimant ? claimant.inboxId : "";
  }

  async _claimRemoteInviteEnvelope({ sdk, inviteId, creatorInboxId, replyInboxId }) {
    const claimWaiter = this.bus.runtime && this.bus.runtime.claimWaiter
      ? this.bus.runtime.claimWaiter : null;
    if (!claimWaiter || typeof claimWaiter.register !== "function") {
      throw new Error("acceptInvite: cross-network claim requires bus.runtime.claimWaiter (ServerPeerLinkProtocolService)");
    }
    if (!replyInboxId) {
      throw new Error("acceptInvite: cannot send claim.req without own localInboxId");
    }
    const requestId = "clm_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 10);
    const waiter = claimWaiter.register(requestId, CLAIM_RES_TIMEOUT_MS);
    const claimBody = JSON.stringify({
      kind: "rez.peerlink.claim.req",
      inviteId,
      replyInboxId,
      requestId,
    });
    const ciphertextB64 = bytesToBase64(new TextEncoder().encode(claimBody));
    const objectId = "clmreq_" + requestId;
    await sdk.mailbox.deposit({
      mailboxId: creatorInboxId,
      objectId,
      ciphertextB64,
      metadata: {},
    });
    return waiter;
  }
}
