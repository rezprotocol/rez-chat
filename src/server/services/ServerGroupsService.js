import { randomUUID } from "node:crypto";
import {
  GroupCreateParams,
  GroupCreateResult,
  GroupLeaveParams,
  GroupLeaveResult,
  GroupMembersListParams,
  GroupMembersListResult,
  GroupsListParams,
  GroupsListResult,
  GroupRenameParams,
  GroupRenameResult,
  GroupKickParams,
  GroupKickResult,
  GroupSetRoleParams,
  GroupSetRoleResult,
  GroupUpdatedEvent,
  GroupRemovedEvent,
  GroupMembersUpdatedEvent,
} from "../../records/index.js";
import { ChatGroupMember } from "../../records/domain/ChatGroupMember.js";
import { GroupOpPayloadV1 } from "../../records/payloads/GroupOpPayloadV1.js";
import { signMemberJoinProof } from "../../records/payloads/memberJoinProof.js";
import { BaseServerService } from "../base/BaseServerService.js";
import { ServerGroupBroadcaster } from "./ServerGroupBroadcaster.js";
import { ServerGroupOpApplier } from "./ServerGroupOpApplier.js";

const ADMIN_ROLE = "admin";
const CREATOR_ROLE = "creator";

function nowOpId() {
  return "gop_" + randomUUID().replace(/-/g, "");
}

export class ServerGroupsService extends BaseServerService {
  #groupStore;
  #threadStore;
  #threadIndex;
  #clock;
  #broadcaster;
  #opApplier;
  #offReconnect;

  constructor({
    bus,
    groupStore,
    threadStore,
    threadIndex,
    ownerAccountId,
    clock = () => Date.now(),
    logger = console,
  } = {}) {
    super({ bus, ownerAccountId, logger });
    if (!groupStore || !threadStore || !threadIndex) {
      throw new Error("ServerGroupsService requires group/thread stores");
    }
    this.#groupStore = groupStore;
    this.#threadStore = threadStore;
    this.#threadIndex = threadIndex;
    this.#clock = clock;
    this.#broadcaster = new ServerGroupBroadcaster({ bus, logger });
    // Inbound group-op application is delegated to ServerGroupOpApplier. The
    // membership/role reads and the members/group "updated" emits stay owned
    // here (local ops use them too — single source of truth) and are injected
    // as bound callbacks so the moved logic keeps the exact same behavior.
    this.#opApplier = new ServerGroupOpApplier({
      bus,
      logger,
      groupStore,
      threadStore,
      ownerAccountId,
      clock,
      broadcaster: this.#broadcaster,
      getMembership: (groupId, accountId) => this.#getMembership(groupId, accountId),
      isCreator: (groupId, accountId) => this.#isCreator(groupId, accountId),
      isEffectiveAdmin: (groupId, membership) => this.#isEffectiveAdmin(groupId, membership),
      listOtherActiveMembers: (groupId) => this.#listOtherActiveMembers(groupId),
      emitMembersUpdated: (groupId) => this.#emitMembersUpdated(groupId),
      emitGroupUpdated: (groupId) => this.#emitGroupUpdated(groupId),
      emit: (type, record) => this._emit(type, record),
    });
    this._register("group", "create", (payload) => this.createGroup(payload));
    this._register("group", "leave", (payload) => this.leaveGroup(payload));
    this._register("group", "rename", (payload) => this.renameGroup(payload));
    this._register("group", "kick", (payload) => this.kickMember(payload));
    this._register("group", "setRole", (payload) => this.setMemberRole(payload));
    this._register("groups", "list", () => this.listGroups());
    this._register("group.members", "list", (payload) => this.listGroupMembers(payload));
    this.#offReconnect = null;
  }

  // On start and every SDK reconnect, re-advertise peer routing so group members
  // mesh (and pre-existing tree-only groups heal). Fire-and-forget — a reconcile
  // failure must never block service start. Mirrors InboxCatchupService's
  // onReconnected wiring.
  async start() {
    const sdk = this.bus.runtime && this.bus.runtime.sdk ? this.bus.runtime.sdk : null;
    if (sdk && sdk.connectivity && typeof sdk.connectivity.onReconnected === "function") {
      this.#offReconnect = sdk.connectivity.onReconnected(() => {
        this.reconcileMesh().catch((err) => {
          this.logger.error("[ServerGroupsService] reconnect mesh reconcile failed: "
            + (err && err.message ? err.message : err));
        });
      });
    }
    this.reconcileMesh().catch((err) => {
      this.logger.error("[ServerGroupsService] startup mesh reconcile failed: "
        + (err && err.message ? err.message : err));
    });
  }

  async stop() {
    if (typeof this.#offReconnect === "function") {
      try {
        this.#offReconnect();
      } catch (err) {
        this.logger.error("[ServerGroupsService] reconnect unsubscribe failed: "
          + (err && err.message ? err.message : err));
      }
      this.#offReconnect = null;
    }
    await super.stop();
  }

  // Re-advertise known peer routing across every group (delegated to the op
  // applier, which owns the broadcaster + peer-link reads). Public so tests and
  // the reconnect hook can drive it.
  async reconcileMesh() {
    return this.#opApplier.reconcileMesh();
  }

  async createGroup(payload = {}) {
    const params = this._coerceParams(payload, GroupCreateParams);
    const title = typeof params.title === "string" ? params.title.trim() : "";
    const creatorDisplayName = typeof params.creatorDisplayName === "string" ? params.creatorDisplayName.trim() : "";
    const now = this.#clock();
    // Salt that binds this group to its creator: groupId = hash(createdBy +
    // ":" + creatorSalt). Carried (signed) in invites so acceptors can verify
    // the founder against the groupId (audit pass 5, H2 closure).
    const creatorSalt = now + ":" + randomUUID();
    const groupId = this.bus.services.threads.groupIdForCreator(this.ownerAccountId, creatorSalt);
    const threadId = this.bus.services.threads.groupThreadId(groupId);
    await this.#groupStore.ensureGroup({
      ownerAccountId: this.ownerAccountId,
      groupId,
      createdBy: this.ownerAccountId,
      title: title || null,
      creatorSalt,
    });
    await this.#groupStore.ensureMembership({
      ownerAccountId: this.ownerAccountId,
      groupId,
      accountId: this.ownerAccountId,
      role: "creator",
      // Name the founder explicitly at creation (no reliance on a later invite).
      displayName: creatorDisplayName || null,
    });
    // Sign the founder's self consent-proof now if we have a name, so they are
    // fully named AND verifiable from creation — co-members can confirm the
    // founder's display name via #broadcastKnownContacts without trusting a
    // forwarder (TRUST-3). No-op when no name was supplied (degrades to the
    // first-invite path). ensureSelfMembershipProof emits members.updated itself.
    if (creatorDisplayName) {
      await this.ensureSelfMembershipProof({ groupId, displayName: creatorDisplayName });
    }
    await this.#threadStore.ensureThread({
      threadId,
      groupId,
      threadType: "group",
      title: title || null,
    });
    const indexRecord = await this.#threadIndex.upsertFromMessage({
      threadId,
      messageId: null,
      ts: now,
      preview: title || "New group",
    });
    this.bus.services.threads.emitThreadIndexUpdated(indexRecord);
    await this.#emitGroupUpdated(groupId);
    await this.#emitMembersUpdated(groupId);
    return new GroupCreateResult({ groupId, threadId });
  }

  async leaveGroup(payload = {}) {
    const params = this._coerceParams(payload, GroupLeaveParams);
    params.validate();
    const groupId = params.groupId;
    const threadId = this.bus.services.threads.groupThreadId(groupId);
    const peers = await this.#listOtherActiveMembers(groupId);
    await this.#groupStore.removeMember({
      ownerAccountId: this.ownerAccountId,
      groupId,
      accountId: this.ownerAccountId,
    });
    await this.#threadStore.setThreadState({
      threadId,
      accessState: "locked",
    });
    this._emit("group.removed", new GroupRemovedEvent({ groupId }));
    await this.#broadcaster.fanOut({
      targets: peers,
      payload: new GroupOpPayloadV1({
        op: "leave",
        groupId,
        accountId: this.ownerAccountId,
        actedAtMs: this.#clock(),
        groupOpId: nowOpId(),
      }),
    });
    return new GroupLeaveResult({ groupId, threadId, left: true });
  }

  /**
   * Discard the locally-optimistic group the acceptor joined via a SINGLE
   * invite (`inviteId`) that the inviter then rejected (invite used up /
   * expired). The teardown is bound to that one invite — it removes only the
   * group stamped with `joinedViaInviteId === inviteId`, never other groups the
   * same inviter set up. The rejected group would silently fail to deliver (no
   * session to the only other member), so we remove its thread + index and drop
   * self-membership. We do NOT fan out a `leave` op: there is no session and we
   * were never truly a member.
   *
   * @param {{ inviteId: string }} opts
   * @returns {Promise<{ removed: string[] }>}
   */
  async discardGroupForRejectedInvite({ inviteId } = {}) {
    const invite = typeof inviteId === "string" ? inviteId.trim() : "";
    if (!invite) return { removed: [] };
    const groups = await this.#groupStore.listGroups({ ownerAccountId: this.ownerAccountId });
    const removed = [];
    for (const group of groups) {
      if (group.joinedViaInviteId !== invite) continue;
      const groupId = group.groupId;
      const threadId = this.bus.services.threads.groupThreadId(groupId);
      const deleted = await this.#threadStore.deleteThread(threadId).catch((err) => {
        this.logger.error("[ServerGroupsService] rejected group thread delete failed", err && err.message ? err.message : err);
        return false;
      });
      if (deleted) {
        await this.#threadIndex.removeThread({ threadId }).catch((err) => {
          this.logger.error("[ServerGroupsService] rejected group index removal failed", err && err.message ? err.message : err);
        });
      }
      await this.#groupStore.removeMember({
        ownerAccountId: this.ownerAccountId,
        groupId,
        accountId: this.ownerAccountId,
      }).catch((err) => {
        this.logger.error("[ServerGroupsService] rejected group membership remove failed", err && err.message ? err.message : err);
      });
      this._emit("group.removed", new GroupRemovedEvent({ groupId }));
      removed.push(groupId);
    }
    return { removed };
  }

  async renameGroup(payload = {}) {
    const params = this._coerceParams(payload, GroupRenameParams);
    params.validate();
    await this.requireSelfAdmin(params.groupId, "group.rename");
    const { group } = await this.#groupStore.renameGroup({
      ownerAccountId: this.ownerAccountId,
      groupId: params.groupId,
      title: params.title,
    });
    if (group) {
      const threadId = this.bus.services.threads.groupThreadId(params.groupId);
      await this.#threadStore.ensureThread({ threadId, groupId: params.groupId, threadType: "group", title: params.title }).catch((err) => {
        this.logger.warn("[ServerGroupsService] thread title sync failed", err);
      });
      this._emit("group.updated", new GroupUpdatedEvent({ group }));
      const peers = await this.#listOtherActiveMembers(params.groupId);
      await this.#broadcaster.fanOut({
        targets: peers,
        payload: new GroupOpPayloadV1({
          op: "rename",
          groupId: params.groupId,
          title: params.title,
          actedAtMs: this.#clock(),
          groupOpId: nowOpId(),
        }),
      });
    }
    return new GroupRenameResult({ group });
  }

  async kickMember(payload = {}) {
    const params = this._coerceParams(payload, GroupKickParams);
    params.validate();
    await this.requireSelfAdmin(params.groupId, "group.kick");
    // The creator is the immutable group anchor — no admin (and not even the
    // creator) may kick them. Without this, a promoted admin could remove the
    // founder and take over the group.
    if (await this.#isCreator(params.groupId, params.accountId)) {
      const err = new Error("group.kick: the group creator cannot be removed");
      err.code = "CREATOR_PROTECTED";
      throw err;
    }
    const peersBefore = await this.#listOtherActiveMembers(params.groupId);
    const { removed } = await this.#groupStore.removeMember({
      ownerAccountId: this.ownerAccountId,
      groupId: params.groupId,
      accountId: params.accountId,
    });
    if (removed) {
      await this.#emitMembersUpdated(params.groupId);
      await this.#emitGroupUpdated(params.groupId);
      const targets = peersBefore.includes(params.accountId)
        ? peersBefore
        : peersBefore.concat(params.accountId);
      await this.#broadcaster.fanOut({
        targets,
        payload: new GroupOpPayloadV1({
          op: "kick",
          groupId: params.groupId,
          accountId: params.accountId,
          actedAtMs: this.#clock(),
          groupOpId: nowOpId(),
        }),
      });
    }
    return new GroupKickResult({
      groupId: params.groupId,
      accountId: params.accountId,
      kicked: removed,
    });
  }

  async setMemberRole(payload = {}) {
    const params = this._coerceParams(payload, GroupSetRoleParams);
    params.validate();
    await this.requireSelfAdmin(params.groupId, "group.setRole");
    // The creator's role is immutable, and "creator" can never be assigned to
    // anyone else (there is exactly one creator = the founder). Both protect
    // against a promoted admin demoting the founder or minting a rival creator.
    if (await this.#isCreator(params.groupId, params.accountId)) {
      const err = new Error("group.setRole: the group creator's role cannot be changed");
      err.code = "CREATOR_PROTECTED";
      throw err;
    }
    if (String(params.role || "").toLowerCase() === CREATOR_ROLE) {
      const err = new Error("group.setRole: the creator role cannot be assigned");
      err.code = "INVALID_ROLE";
      throw err;
    }
    const { membership } = await this.#groupStore.setMemberRole({
      ownerAccountId: this.ownerAccountId,
      groupId: params.groupId,
      accountId: params.accountId,
      role: params.role,
    });
    if (membership) {
      await this.#emitMembersUpdated(params.groupId);
      const peers = await this.#listOtherActiveMembers(params.groupId);
      await this.#broadcaster.fanOut({
        targets: peers,
        payload: new GroupOpPayloadV1({
          op: "setRole",
          groupId: params.groupId,
          accountId: params.accountId,
          role: membership.role,
          actedAtMs: this.#clock(),
          groupOpId: nowOpId(),
        }),
      });
    }
    return new GroupSetRoleResult({
      groupId: params.groupId,
      accountId: params.accountId,
      role: membership ? membership.role : params.role,
    });
  }

  async listGroups(payload = {}) {
    this._coerceParams(payload, GroupsListParams);
    const items = await this.#groupStore.listGroups({ ownerAccountId: this.ownerAccountId });
    return new GroupsListResult({ items });
  }

  async listGroupMembers(payload = {}) {
    const params = this._coerceParams(payload, GroupMembersListParams);
    const items = await this.#groupStore.listMembers({
      ownerAccountId: this.ownerAccountId,
      groupId: params.groupId,
    });
    const withFounderRole = await this.#stampFounderAsAdmin(params.groupId, items);
    const enriched = await this.#enrichMembersWithContacts(withFounderRole);
    return new GroupMembersListResult({ items: enriched });
  }

  // The founder (group.createdBy) is always the CREATOR regardless of how the
  // member row was persisted. Stamp role="creator" on the founder's row when
  // returning to callers, so display + downstream checks stay consistent.
  // Public so ServerThreadsService can apply the same rule to its own
  // members-updated emits — single source of truth for the founder rule.
  // (Name retained for callers; it now stamps "creator".)
  async stampFounderAsAdmin(groupId, items) {
    return this.#stampFounderAsAdmin(groupId, items);
  }

  async #stampFounderAsAdmin(groupId, items) {
    const list = Array.isArray(items) ? items : [];
    const group = await this.#groupStore.getGroup({
      ownerAccountId: this.ownerAccountId,
      groupId,
    }).catch(() => null);
    const founder = group && typeof group.createdBy === "string" ? group.createdBy : "";
    if (!founder) return list;
    const out = [];
    for (const member of list) {
      const mid = String(member && member.accountId || "").trim();
      if (mid === founder && String(member.role || "").toLowerCase() !== CREATOR_ROLE) {
        out.push(new ChatGroupMember({ ...member.toJSON(), role: CREATOR_ROLE }));
      } else {
        out.push(member);
      }
    }
    return out;
  }

  // The creator is the immutable founder: group.createdBy (authoritative,
  // cryptographically bound to the groupId — see acceptInvite). We key
  // protection on createdBy, NOT the stored role string, so a stale/tampered
  // role can't strip creator protection.
  async #isCreator(groupId, accountId) {
    const id = typeof accountId === "string" ? accountId.trim() : "";
    if (!id) return false;
    const group = await this.#groupStore.getGroup({
      ownerAccountId: this.ownerAccountId,
      groupId,
    }).catch(() => null);
    return Boolean(group && typeof group.createdBy === "string" && group.createdBy === id);
  }

  // Apply an inbound group op received from a peer. The full applier logic
  // (authorization, anti-resurrection, creator protection, fan-out) lives in
  // ServerGroupOpApplier; this stays the public entry point ServerEventService
  // dispatches to.
  async handleIncomingGroupOp(record, ctx) {
    return this.#opApplier.handle(record, ctx);
  }

  /**
   * Sent by the new member's chat-server (via ServerInvitesService) right
   * after acceptInvite succeeds. Encloses the inviteId so the inviter can
   * authorize the join against the invite record they hold.
   */
  async sendMemberJoinOp({ groupId, inviterAccountId, inviteId, displayName = "" } = {}) {
    const gid = typeof groupId === "string" ? groupId.trim() : "";
    const inviter = typeof inviterAccountId === "string" ? inviterAccountId.trim() : "";
    const id = typeof inviteId === "string" ? inviteId.trim() : "";
    if (!gid || !inviter || !id) return;
    // REZ-2: sign a membership-consent proof with our account key. Recipients
    // (the inviter, and every forward recipient) verify it before conferring our
    // membership, so a member cannot forge a join for an account they don't hold.
    const authority = this.bus.runtime && this.bus.runtime.accountAuthority ? this.bus.runtime.accountAuthority : null;
    if (!authority || !authority.signer) {
      this.logger.error("[ServerGroupsService] member.join NOT sent — no account authority to sign consent proof");
      return;
    }
    const ownName = typeof displayName === "string" ? displayName : "";
    let proof;
    try {
      proof = await signMemberJoinProof({
        signer: authority.signer, groupId: gid, accountId: this.ownerAccountId, displayName: ownName,
      });
    } catch (err) {
      this.logger.error("[ServerGroupsService] member.join consent-proof signing failed",
        err && err.message ? err.message : err);
      return;
    }
    // Persist our own proof + the EXACT name it was signed over onto our
    // self-membership row, so the mesh-bootstrap path (#broadcastKnownContacts) can
    // re-advertise us — name and proof must stay a matched pair to re-verify.
    await this.#groupStore.ensureMembership({
      ownerAccountId: this.ownerAccountId, groupId: gid, accountId: this.ownerAccountId,
      displayName: ownName, joinProof: proof,
    }).catch((err) => {
      this.logger.warn("[ServerGroupsService] failed to persist own member.join proof",
        err && err.message ? err.message : err);
    });
    const payload = new GroupOpPayloadV1({
      op: "member.join",
      groupId: gid,
      accountId: this.ownerAccountId,
      inviteId: id,
      displayName: ownName,
      joinerSignerPublicKeyB64: proof.joinerSignerPublicKeyB64,
      joinerSigB64: proof.joinerSigB64,
      actedAtMs: this.#clock(),
      groupOpId: nowOpId(),
    });
    await this.#broadcaster.fanOut({ targets: [inviter], payload });
  }

  // The founder is the only member who never runs the member.join path (they
  // CREATED the group instead of joining it), so their self-membership row
  // carries no name-bound consent proof — and #broadcastKnownContacts would
  // advertise them with an empty displayName, leaving invitees with a nameless
  // creator row. Sign a self consent-proof now, bound to the EXACT name they're
  // inviting under, so co-members can cryptographically VERIFY the founder's
  // display name (not merely trust a forwarder — TRUST-3). No-op once a proof
  // exists (joiners already have one; a founder re-signs only the first time).
  async ensureSelfMembershipProof({ groupId, displayName = "" } = {}) {
    const gid = typeof groupId === "string" ? groupId.trim() : "";
    const name = typeof displayName === "string" ? displayName.trim() : "";
    if (!gid || !name) return;
    const existing = await this.#getMembership(gid, this.ownerAccountId);
    if (!existing) return;
    const hasProof = typeof existing.joinerSigB64 === "string" && existing.joinerSigB64;
    if (hasProof) return;
    const authority = this.bus.runtime && this.bus.runtime.accountAuthority ? this.bus.runtime.accountAuthority : null;
    if (!authority || !authority.signer) {
      this.logger.error("[ServerGroupsService] cannot sign founder self-proof — no account authority");
      return;
    }
    let proof;
    try {
      proof = await signMemberJoinProof({
        signer: authority.signer, groupId: gid, accountId: this.ownerAccountId, displayName: name,
      });
    } catch (err) {
      this.logger.error("[ServerGroupsService] founder self-proof signing failed",
        err && err.message ? err.message : err);
      return;
    }
    const { created, upgraded } = await this.#groupStore.ensureMembership({
      ownerAccountId: this.ownerAccountId, groupId: gid, accountId: this.ownerAccountId,
      displayName: name, joinProof: proof,
    }).catch((err) => {
      this.logger.warn("[ServerGroupsService] failed to persist founder self-proof",
        err && err.message ? err.message : err);
      return { created: false, upgraded: false };
    });
    // Refresh our own roster: this upgrades a nameless creator row with our name,
    // so the UI must re-render or the founder sees their own bare account id.
    if (created || upgraded) await this.#emitMembersUpdated(gid);
  }

  async #getMembership(groupId, accountId) {
    if (!groupId || !accountId) return null;
    const members = await this.#groupStore.listMembers({
      ownerAccountId: this.ownerAccountId,
      groupId,
    }).catch(() => []);
    const list = Array.isArray(members) ? members : [];
    return list.find((m) => {
      const id = String(m && m.accountId || "").trim();
      return id === accountId;
    }) || null;
  }

  // Public so peer services (e.g. ServerChannelsService) can reuse the same
  // admin gate via bus.services.groups instead of inlining the membership +
  // role check. Throws typed errors: NOT_A_MEMBER, ADMIN_REQUIRED.
  //
  // Effective admin = the group's founder (group.createdBy) OR any active
  // member with role="admin" (set via group.setRole). The founder is the
  // implicit admin and is derived from group.createdBy — there is no
  // separately-synchronized "role" field needed for that case.
  async requireSelfAdmin(groupId, opLabel) {
    const self = await this.#getMembership(groupId, this.ownerAccountId);
    if (!self || String(self.state || "").toLowerCase() !== "active") {
      const err = new Error(opLabel + ": caller is not an active member of group " + groupId);
      err.code = "NOT_A_MEMBER";
      throw err;
    }
    if (!(await this.#isEffectiveAdmin(groupId, self))) {
      const err = new Error(opLabel + ": admin role required");
      err.code = "ADMIN_REQUIRED";
      throw err;
    }
  }

  async #isEffectiveAdmin(groupId, membership) {
    if (!membership) return false;
    const role = String(membership.role || "").toLowerCase();
    // The creator has all admin powers (and more); admin manages members.
    if (role === ADMIN_ROLE || role === CREATOR_ROLE) return true;
    const group = await this.#groupStore.getGroup({
      ownerAccountId: this.ownerAccountId,
      groupId,
    }).catch(() => null);
    if (group && typeof group.createdBy === "string"
        && group.createdBy === membership.accountId) {
      return true;
    }
    return false;
  }

  async #listOtherActiveMembers(groupId) {
    const members = await this.#groupStore.listMembers({
      ownerAccountId: this.ownerAccountId,
      groupId,
    }).catch(() => []);
    const list = Array.isArray(members) ? members : [];
    const out = [];
    for (const m of list) {
      const id = String(m && m.accountId || "").trim();
      const state = String(m && m.state || "active").toLowerCase();
      if (!id || id === this.ownerAccountId || state !== "active") continue;
      out.push(id);
    }
    return out;
  }

  async #enrichMembersWithContacts(items) {
    const list = Array.isArray(items) ? items : [];
    const contactsService = this.bus.services && this.bus.services.contacts ? this.bus.services.contacts : null;
    if (!contactsService || typeof contactsService.listContacts !== "function") return list;
    const contactsResult = await contactsService.listContacts({});
    const contactItems = contactsResult && Array.isArray(contactsResult.items) ? contactsResult.items : [];
    const contactsByAccountId = new Map();
    for (const c of contactItems) {
      const cid = String(c && c.accountId || "").trim();
      if (cid) contactsByAccountId.set(cid, c);
    }
    const out = [];
    for (const member of list) {
      const mid = String(member.accountId || "").trim();
      const contact = contactsByAccountId.get(mid);
      if (contact && contact.displayName && !member.displayName) {
        out.push(new ChatGroupMember({
          ...member.toJSON(),
          displayName: String(contact.displayName).trim(),
        }));
      } else {
        out.push(member);
      }
    }
    return out;
  }

  async #emitGroupUpdated(groupId) {
    if (!groupId) return;
    const groups = await this.#groupStore.listGroups({ ownerAccountId: this.ownerAccountId }).catch(() => []);
    const list = Array.isArray(groups) ? groups : [];
    const group = list.find((g) => g && g.groupId === groupId) || null;
    if (group) this._emit("group.updated", new GroupUpdatedEvent({ group }));
  }

  async #emitMembersUpdated(groupId) {
    if (!groupId) return;
    const items = await this.#groupStore.listMembers({
      ownerAccountId: this.ownerAccountId,
      groupId,
    }).catch(() => []);
    const withFounderRole = await this.#stampFounderAsAdmin(groupId, items);
    const enriched = await this.#enrichMembersWithContacts(withFounderRole);
    this._emit("group.members.updated", new GroupMembersUpdatedEvent({ groupId, members: enriched }));
  }
}
