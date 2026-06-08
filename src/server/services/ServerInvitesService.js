import {
  InviteAcceptParams,
  InviteAcceptResult,
  InviteCreateParams,
  InviteCreateResult,
} from "../../records/index.js";
import { BaseServerService } from "../base/BaseServerService.js";
import {
  base64ToBytes,
  buildInboxAddress,
  buildRendezvousAddress,
  encodeInviteCodeV3,
  isInviteCodeV3,
  parseInviteCodeV3,
  PEERLINK_INVITE_RECORD_KIND,
} from "@rezprotocol/sdk/client";

/**
 * ServerInvitesService — chat-server-side peer-link invite create + accept
 * (Shape A). Uses the local PeerLinkService (`bus.runtime.peerLinks`) so
 * records land in chat-server storage. The signed invite envelope is
 * published to / fetched from the durable signed-record store
 * (`sdk.durableRecords`), so accepts succeed with the inviter offline.
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
    // The invite's reply binding (our persistent claimed inbox) is configured
    // intrinsically on PeerLinkService at construction (see bootstrapChatServer),
    // so createInvite anchors it automatically — this path no longer hand-passes
    // peerInboxId. We still require a claimed inbox to exist: without it the
    // chat-server isn't routable and shouldn't be minting invites.
    const inboxClaimant = this.bus.runtime && this.bus.runtime.inboxClaimant
      ? this.bus.runtime.inboxClaimant : null;
    if (!inboxClaimant) {
      throw new Error("createInvite: chat-server requires bus.runtime.inboxClaimant");
    }

    const kind = params.kind === "group" ? "group" : "direct";
    const groupId = kind === "group" && typeof params.groupId === "string" && params.groupId.trim() ? params.groupId.trim() : null;

    // SECURITY (audit pass 5, H2): only an ACTIVE member may mint a group
    // invite, and the invite must carry the group's TRUE founder so the
    // acceptor doesn't stamp the inviter as createdBy (which the founder rule
    // would turn into permanent admin). Both are derived from our own group
    // state — the single authority for who founded/belongs to the group.
    let groupCreatedBy = null;
    let groupSalt = null;
    if (kind === "group") {
      if (!groupId) {
        const err = new Error("createInvite: group invite requires groupId");
        err.code = "INVALID_GROUP";
        throw err;
      }
      const groupStore = this.bus.stores && this.bus.stores.groupStore ? this.bus.stores.groupStore : null;
      if (!groupStore) throw new Error("createInvite: groupStore unavailable");
      // The node's own account — the key the group store is owned/membered
      // under (ServerInvitesService isn't constructed with ownerAccountId).
      const selfAccountId = peerLinks.ownerAccountId;
      const self = await groupStore.getMembership({
        ownerAccountId: selfAccountId, groupId, accountId: selfAccountId,
      });
      if (!self || String(self.state || "").toLowerCase() !== "active") {
        const err = new Error("createInvite: only an active member can invite to a group");
        err.code = "NOT_A_MEMBER";
        throw err;
      }
      const group = await groupStore.getGroup({ ownerAccountId: selfAccountId, groupId });
      groupCreatedBy = group && typeof group.createdBy === "string" && group.createdBy.trim()
        ? group.createdBy.trim() : selfAccountId;
      // The salt that lets the acceptor verify groupCreatedBy against groupId.
      // Relayed from our own group state (we received + verified it when we
      // joined, or minted it if we are the founder).
      groupSalt = group && typeof group.creatorSalt === "string" && group.creatorSalt.trim()
        ? group.creatorSalt.trim() : null;
    }
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
      groupCreatedBy,
      groupSalt,
      title,
      maxUses,
      expiresAtMs: Date.now() + expiresInDays * 24 * 60 * 60 * 1000,
    });

    const inviteCode = encodeInviteCodeV3({
      inviteId: result.inviteId,
      publisherPublicKeyB64: result.publisherPublicKeyB64,
    });

    // Publish the signed envelope at its rendezvous coordinate so acceptors can
    // fetch it while the inviter is offline. The inviter is, by definition,
    // online here at create time — dispatch pushes it to the k-closest backbone
    // nodes, which keep it alive thereafter. Local-only fallback (replicas=0)
    // still lets same-node accepts resolve via the stored invite record.
    //
    // ServerInvitesService names the rendezvous coordinate (the invite's
    // identity); the mesh owns the mechanism. It does NOT call durableRecords
    // directly — that selection is routing's, not the creator's.
    const sdk = this._sdk();
    await sdk.mesh.dispatch(
      { record: result.durableRecord },
      buildRendezvousAddress({
        recordKind: PEERLINK_INVITE_RECORD_KIND,
        recordId: result.inviteId,
        publisherPublicKeyB64: result.publisherPublicKeyB64,
      }),
    );

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
    if (!isInviteCodeV3(inviteCode)) {
      throw new Error("acceptInvite: only v3 short codes are supported");
    }
    const { inviteId, publisherPublicKeyB64 } = parseInviteCodeV3(inviteCode);

    // 1. Resolve envelope: local-first (the inviter's own stored record, for
    // same-node accepts), else fetch the inviter's durable invite record from
    // the DHT. The durable record is self-authenticating and reachable with
    // the inviter offline — no live claim round-trip. maxUses is NOT spent at
    // accept time; it is enforced lazily, once, by the inviter's handshake
    // responder (the single enforcement point).
    const ownerAccountId = peerLinks.ownerAccountId;
    let envelopeData = await peerLinks.getStoredInviteEnvelope(ownerAccountId, inviteId);
    if (!envelopeData) {
      envelopeData = await this._fetchDurableInviteEnvelope({
        sdk, inviteId, publisherPublicKeyB64,
      });
    }
    if (!envelopeData || !envelopeData.envelope) {
      const err = new Error("acceptInvite: invite envelope not found");
      err.code = "INVITE_NOT_FOUND";
      throw err;
    }

    // Substitution safety: the fetched envelope MUST be signed by the same
    // identity the invite code commits to. The node already bound the record
    // to publisherPublicKeyB64; this binds the inner envelope's signer too,
    // so a record publisher cannot wrap a different inviter's envelope.
    const envelopeSignerPub = envelopeData.envelope.signerRef
      && typeof envelopeData.envelope.signerRef.signerPublicKeyB64 === "string"
      ? envelopeData.envelope.signerRef.signerPublicKeyB64 : "";
    if (envelopeSignerPub !== publisherPublicKeyB64) {
      const err = new Error("acceptInvite: invite envelope signer does not match invite code");
      err.code = "PUBLISHER_KEY_MISMATCH";
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
        await sdk.mesh.dispatch(
          { payloadBytes: handshakePacket.toBytes(), objectId, metadata: {} },
          buildInboxAddress({ inboxId: target }),
        );
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
      // Stamp the invite this group was joined via so a later handshake.reject
      // can tear down exactly this group (bound to the one invite). Matches the
      // peer-link's activeInviteId (envelope.inviteId).
      const joinedViaInviteId = typeof envelopeObj.inviteId === "string" ? envelopeObj.inviteId.trim() : null;
      // The TRUE founder, carried (signed) in the envelope — NOT the inviter.
      // Stamping the inviter as createdBy let the founder rule grant them
      // permanent admin over us (audit pass 5, H2).
      const groupCreatedBy = typeof envelopeObj.groupCreatedBy === "string" && envelopeObj.groupCreatedBy.trim()
        ? envelopeObj.groupCreatedBy.trim() : null;
      const groupSalt = typeof envelopeObj.groupSalt === "string" && envelopeObj.groupSalt.trim()
        ? envelopeObj.groupSalt.trim() : null;
      // VERIFY the founder against the groupId itself: groupId must equal
      // hash(groupCreatedBy + ":" + groupSalt). This closes the H2 residual —
      // a malicious inviter cannot self-stamp as creator, because they can't
      // produce a (createdBy, salt) pair that hashes to a group they didn't
      // found. Fail closed: a group invite whose founder binding doesn't
      // verify is rejected outright.
      const verifiedCreatedBy = groupCreatedBy && groupSalt
        && this.bus.services.threads.groupIdForCreator(groupCreatedBy, groupSalt) === groupId
        ? groupCreatedBy : null;
      if (groupCreatedBy && !verifiedCreatedBy) {
        const err = new Error("acceptInvite: group founder does not match the groupId (binding failed)");
        err.code = "GROUP_CREATOR_BINDING_INVALID";
        throw err;
      }
      await this.bus.services.threads.ensureGroupThread({
        groupId,
        peerAccountId,
        groupCreatedBy: verifiedCreatedBy,
        creatorSalt: verifiedCreatedBy ? groupSalt : null,
        createdAtMs: Date.now(),
        title,
        joinedViaInviteId,
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

  /**
   * Fetch the inviter's signed invite envelope from the durable-record store
   * (DHT). Self-authenticating and reachable with the inviter offline — the
   * node has already verified the record's signature + slot-binding against
   * `publisherPublicKeyB64` before returning it. Returns `{ envelope,
   * signatureB64 }` or null if absent/malformed.
   *
   * NOTE (deferred, not drift): the publish side of this flow goes through the
   * unified `mesh.dispatch(rendezvous-address)` verb, but this READ side still
   * names `durableRecords` directly. There is intentionally no `mesh.resolve`
   * fetch primitive yet — it lands in the Phase-4 "one overlay find" work, at
   * which point this call migrates too. Until then the asymmetry is expected.
   */
  async _fetchDurableInviteEnvelope({ sdk, inviteId, publisherPublicKeyB64 }) {
    const record = await sdk.durableRecords.get({
      recordKind: PEERLINK_INVITE_RECORD_KIND,
      recordId: inviteId,
      publisherPublicKeyB64,
    });
    if (!record || typeof record.payloadB64 !== "string") {
      return null;
    }
    let payload;
    try {
      payload = JSON.parse(new TextDecoder().decode(base64ToBytes(record.payloadB64)));
    } catch (err) {
      this.logger.warn("[ServerInvitesService] durable invite record payload malformed",
        err && err.message ? err.message : err);
      return null;
    }
    if (!payload || typeof payload !== "object" || !payload.envelope) {
      return null;
    }
    return {
      envelope: payload.envelope,
      signatureB64: typeof payload.signatureB64 === "string" ? payload.signatureB64 : null,
    };
  }
}
