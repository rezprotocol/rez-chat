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
import { GroupOpPayloadV1, groupOpPayloadToBytes } from "../../records/payloads/GroupOpPayloadV1.js";
import { SYSTEM_EVENT_KIND } from "../../records/payloads/ChatSystemEventPayloadV1.js";
import { BaseServerService } from "../base/BaseServerService.js";

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
    this._register("group", "create", (payload) => this.createGroup(payload));
    this._register("group", "leave", (payload) => this.leaveGroup(payload));
    this._register("group", "rename", (payload) => this.renameGroup(payload));
    this._register("group", "kick", (payload) => this.kickMember(payload));
    this._register("group", "setRole", (payload) => this.setMemberRole(payload));
    this._register("groups", "list", () => this.listGroups());
    this._register("group.members", "list", (payload) => this.listGroupMembers(payload));
  }

  async createGroup(payload = {}) {
    const params = this._coerceParams(payload, GroupCreateParams);
    const title = typeof params.title === "string" ? params.title.trim() : "";
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
    });
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
    await this.#fanOutGroupOp({
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
      await this.#fanOutGroupOp({
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
      await this.#fanOutGroupOp({
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
      await this.#fanOutGroupOp({
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

  async handleIncomingGroupOp(record, { senderAccountId } = {}) {
    // ServerEventService constructs the GroupOpPayloadV1 record at the
    // receive boundary; we just check the type and use it.
    if (!(record instanceof GroupOpPayloadV1)) return false;
    const sender = typeof senderAccountId === "string" ? senderAccountId.trim() : "";
    if (!sender) {
      this.logger.warn("[ServerGroupsService] handleIncomingGroupOp: no sender, dropping op=" + (record && record.op));
      return false;
    }
    const op = record;

    // member.join is the bootstrap exception: the joiner is NOT yet a
    // group member when self-announcing, so we cannot gate on membership.
    // Authorization is checked inside the handler against the persisted
    // invite record (direct self-announce) or against the sender's group
    // membership (forwarded by the inviter — same trust model as rename/
    // kick/setRole forwarding).
    if (op.op === "member.join") {
      await this.#applyIncomingMemberJoin(op, { senderAccountId: sender });
      return true;
    }

    const senderMembership = await this.#getMembership(op.groupId, sender);
    if (!senderMembership || senderMembership.state !== "active") {
      // Drop is permanent (not retried) — log loudly so downstream debugging
      // is possible. If this fires for someone who IS a member from their
      // side, our local membership is stale and a reconcile may be needed.
      this.logger.warn(
        "[ServerGroupsService] dropped group-op " + op.op + " from non-member " + sender
        + " for group " + op.groupId
        + " (local membership=" + (senderMembership ? senderMembership.state : "none") + ")"
      );
      return true;
    }
    // Effective admin: explicit role OR group founder (group.createdBy).
    const isAdmin = await this.#isEffectiveAdmin(op.groupId, senderMembership);

    if (op.op === "rename") {
      await this.#applyIncomingRename(op);
      return true;
    }
    if (op.op === "kick") {
      if (!isAdmin) {
        this.logger.warn("[ServerGroupsService] ignoring kick from non-admin " + sender);
        return true;
      }
      await this.#applyIncomingKick(op);
      return true;
    }
    if (op.op === "setRole") {
      if (!isAdmin) {
        this.logger.warn("[ServerGroupsService] ignoring setRole from non-admin " + sender);
        return true;
      }
      await this.#applyIncomingSetRole(op);
      return true;
    }
    if (op.op === "leave") {
      if (op.accountId !== sender) {
        this.logger.warn("[ServerGroupsService] ignoring leave with mismatched sender");
        return true;
      }
      await this.#applyIncomingLeave(op);
      return true;
    }
    if (op.op === "channel.create" || op.op === "channel.delete") {
      const channelsService = this.bus.services && this.bus.services.channels;
      if (!channelsService || typeof channelsService.applyIncomingOp !== "function") {
        this.logger.warn("[ServerGroupsService] channel op received but channels service not registered");
        return true;
      }
      await channelsService.applyIncomingOp(op, { senderAccountId: sender, isAdmin });
      return true;
    }
    if (op.op === "channels.sync_request") {
      const channelsService = this.bus.services && this.bus.services.channels;
      if (!channelsService || typeof channelsService.fanoutChannelsToPeer !== "function") {
        this.logger.warn("[ServerGroupsService] channels.sync_request received but channels service not registered");
        return true;
      }
      await channelsService.fanoutChannelsToPeer({
        groupId: op.groupId,
        peerAccountId: sender,
      }).catch((err) => {
        this.logger.warn("[ServerGroupsService] channels.sync_request fanout failed",
          err && err.message ? err.message : err);
      });
      // Catch-up requesters also need current group state (title) that they
      // may have missed because they joined or were offline during rename
      // fan-out. We send an explicit `group.state` op for this — never a
      // synthesized rename. Receiver fills empty titles only; never
      // overwrites a non-empty local title.
      await this.#advertiseGroupStateToPeer({ groupId: op.groupId, peerAccountId: sender })
        .catch((err) => {
          this.logger.warn("[ServerGroupsService] group.state advertise to " + sender + " failed",
            err && err.message ? err.message : err);
        });
      return true;
    }
    if (op.op === "group.state") {
      await this.#applyIncomingGroupState(op);
      return true;
    }
    return true;
  }

  async #applyIncomingRename(op) {
    const existingGroup = await this.#groupStore.getGroup({
      ownerAccountId: this.ownerAccountId,
      groupId: op.groupId,
    }).catch(() => null);
    if (existingGroup
        && Number.isFinite(Number(existingGroup.updatedAtMs))
        && Number(existingGroup.updatedAtMs) >= op.actedAtMs) {
      return;
    }
    const { group } = await this.#groupStore.renameGroup({
      ownerAccountId: this.ownerAccountId,
      groupId: op.groupId,
      title: op.title,
    });
    if (group) {
      const threadId = this.bus.services.threads.groupThreadId(op.groupId);
      await this.#threadStore.ensureThread({
        threadId,
        groupId: op.groupId,
        threadType: "group",
        title: op.title,
      }).catch((err) => {
        this.logger.warn("[ServerGroupsService] thread title sync failed (incoming rename)", err);
      });
      this._emit("group.updated", new GroupUpdatedEvent({ group }));
    }
  }

  /**
   * Catch-up advertisement of current group state to a peer requesting a
   * sync. Sends an explicit `group.state` op (NOT a rename). The receiver
   * fills its title only if currently empty — never overwrites. This is
   * distinct from rename, which is a user-initiated LWW mutation.
   */
  async #advertiseGroupStateToPeer({ groupId, peerAccountId } = {}) {
    if (!groupId || !peerAccountId || peerAccountId === this.ownerAccountId) return;
    const group = await this.#groupStore.getGroup({
      ownerAccountId: this.ownerAccountId,
      groupId,
    }).catch(() => null);
    if (!group) return;
    const title = typeof group.title === "string" ? group.title.trim() : "";
    if (!title) return;
    const actedAtMs = Number.isFinite(Number(group.updatedAtMs))
      ? Number(group.updatedAtMs)
      : Number(group.createdAtMs) || this.#clock();
    await this.#fanOutGroupOp({
      targets: [peerAccountId],
      payload: new GroupOpPayloadV1({
        op: "group.state",
        groupId,
        title,
        actedAtMs,
        groupOpId: nowOpId(),
      }),
    });
  }

  async #applyIncomingGroupState(op) {
    const existingGroup = await this.#groupStore.getGroup({
      ownerAccountId: this.ownerAccountId,
      groupId: op.groupId,
    }).catch(() => null);
    if (!existingGroup) return;
    const hasTitle = typeof existingGroup.title === "string"
      && existingGroup.title.trim().length > 0;
    if (hasTitle) return;
    const newTitle = typeof op.title === "string" ? op.title.trim() : "";
    if (!newTitle) return;
    const { group } = await this.#groupStore.renameGroup({
      ownerAccountId: this.ownerAccountId,
      groupId: op.groupId,
      title: newTitle,
    });
    if (group) {
      const threadId = this.bus.services.threads.groupThreadId(op.groupId);
      await this.#threadStore.ensureThread({
        threadId,
        groupId: op.groupId,
        threadType: "group",
        title: newTitle,
      }).catch((err) => {
        this.logger.warn("[ServerGroupsService] thread title sync failed (group.state)", err);
      });
      this._emit("group.updated", new GroupUpdatedEvent({ group }));
    }
  }

  async #applyIncomingKick(op) {
    // Authoritative creator protection on every receiving node: ignore a kick
    // targeting the group creator no matter who sent it (a compromised/colluding
    // admin could craft this op directly). Each node knows its own createdBy.
    if (await this.#isCreator(op.groupId, op.accountId)) {
      this.logger.warn("[ServerGroupsService] ignoring kick targeting the group creator " + op.accountId);
      return;
    }
    const targetIsSelf = op.accountId === this.ownerAccountId;
    const { removed } = await this.#groupStore.removeMember({
      ownerAccountId: this.ownerAccountId,
      groupId: op.groupId,
      accountId: op.accountId,
    });
    if (!removed) return;
    if (targetIsSelf) {
      const threadId = this.bus.services.threads.groupThreadId(op.groupId);
      await this.#threadStore.setThreadState({ threadId, accessState: "locked" }).catch((err) => {
        this.logger.warn("[ServerGroupsService] thread lock failed after self-kick", err);
      });
      this._emit("group.removed", new GroupRemovedEvent({ groupId: op.groupId }));
      return;
    }
    await this.#emitMembersUpdated(op.groupId);
    await this.#emitGroupUpdated(op.groupId);
  }

  async #applyIncomingSetRole(op) {
    // Authoritative creator protection: never let an inbound op change the
    // creator's role or mint a second creator, regardless of sender.
    if (await this.#isCreator(op.groupId, op.accountId)) {
      this.logger.warn("[ServerGroupsService] ignoring setRole targeting the group creator " + op.accountId);
      return;
    }
    if (String(op.role || "").toLowerCase() === CREATOR_ROLE) {
      this.logger.warn("[ServerGroupsService] ignoring setRole that would assign the creator role");
      return;
    }
    const { membership } = await this.#groupStore.setMemberRole({
      ownerAccountId: this.ownerAccountId,
      groupId: op.groupId,
      accountId: op.accountId,
      role: op.role,
    });
    if (membership) {
      await this.#emitMembersUpdated(op.groupId);
    }
  }

  async #applyIncomingLeave(op) {
    if (op.accountId === this.ownerAccountId) return;
    const { removed } = await this.#groupStore.removeMember({
      ownerAccountId: this.ownerAccountId,
      groupId: op.groupId,
      accountId: op.accountId,
    });
    if (!removed) return;
    await this.#emitMembersUpdated(op.groupId);
    await this.#emitGroupUpdated(op.groupId);
  }

  /**
   * Apply an inbound member.join op. Two cases:
   *
   *   - sender === op.accountId: direct self-announce from the joiner.
   *     Authorization is proved against our persisted invite record
   *     (we are the inviter). If the invite doesn't exist locally, the
   *     joiner is claiming a group invite we never issued — drop.
   *
   *   - sender !== op.accountId: forwarded from a group member (likely
   *     the inviter) to bring us up to date. Authorization is the
   *     sender's current membership in the group — same trust model
   *     as rename/kick/setRole forwarding.
   *
   * In both cases: ensure the group thread + membership locally, persist
   * a system event into the group thread for the UI to render, and (in
   * the inviter direct-self-announce case) fan out the op to every other
   * active member so the rest of the group learns about the new joiner.
   */
  async #applyIncomingMemberJoin(op, { senderAccountId } = {}) {
    const sender = typeof senderAccountId === "string" ? senderAccountId.trim() : "";
    const joiner = typeof op.accountId === "string" ? op.accountId.trim() : "";
    if (!sender || !joiner) return;
    if (joiner === this.ownerAccountId) return;
    const isSelfAnnounce = sender === joiner;

    // Current local membership for the joiner drives add-vs-revive and the
    // anti-resurrection rules below.
    const existingMembership = await this.#getMembership(op.groupId, joiner);
    const wasRemoved = existingMembership
      && String(existingMembership.state || "").toLowerCase() === "removed";

    let shouldForward = false;
    if (isSelfAnnounce) {
      // Direct self-announce: WE are the inviter, so we authorize against our
      // own invite record (forward recipients can't — they have no invite).
      const envelope = await this.#resolveJoinInviteEnvelope({
        inviteId: op.inviteId,
        groupId: op.groupId,
      });
      if (!envelope) {
        this.logger.warn(
          "[ServerGroupsService] dropping member.join from " + joiner
            + ": no matching local invite for group " + op.groupId,
        );
        return;
      }
      // Anti-resurrection — clock-safe HERE because we (the inviter) stamped
      // BOTH the invite's createdAtMs and the membership's removal time on our
      // own clock. A kicked/departed member may only be re-admitted by an
      // invite issued AFTER their removal; a stale invite predating the kick
      // cannot undo it.
      if (wasRemoved) {
        const inviteCreatedAtMs = Number(envelope.createdAtMs) || 0;
        const removedAtMs = Number(existingMembership.updatedAtMs) || 0;
        if (!(inviteCreatedAtMs > removedAtMs)) {
          this.logger.warn(
            "[ServerGroupsService] dropping member.join from removed member " + joiner
              + ": invite predates removal (stale-invite reuse) for group " + op.groupId,
          );
          return;
        }
      }
      // Invite-level authorization: expiry + maxUses, against the invite ledger
      // (single source of truth with the handshake responder). This is the ONLY
      // maxUses enforcement point when the joiner already has an established
      // peer-link (no fresh handshake runs in that case).
      const peerLinks = this.bus.runtime && this.bus.runtime.peerLinks ? this.bus.runtime.peerLinks : null;
      if (!peerLinks || typeof peerLinks.authorizeInviteJoin !== "function") {
        this.logger.warn("[ServerGroupsService] member.join: peerLinks.authorizeInviteJoin unavailable");
        return;
      }
      const verdict = await peerLinks.authorizeInviteJoin({
        ownerAccountId: this.ownerAccountId,
        inviteId: op.inviteId,
        joinerAccountId: joiner,
        nowMs: this.#clock(),
      }).catch((err) => {
        this.logger.warn("[ServerGroupsService] member.join authorize failed",
          err && err.message ? err.message : err);
        return { authorized: false, reason: "AUTHORIZE_ERROR" };
      });
      if (!verdict || !verdict.authorized) {
        this.logger.warn(
          "[ServerGroupsService] dropping unauthorized member.join from " + joiner
            + " for group " + op.groupId + " (" + (verdict ? verdict.reason : "no-verdict") + ")",
        );
        return;
      }
      shouldForward = true;
    } else {
      // Forwarded by another member (likely the inviter). We trust the
      // forwarder's active membership — but a forward may only ADD a new
      // member, NEVER resurrect a removed one. Reviving a kicked member
      // requires the inviter's freshness-gated self-announce path above;
      // otherwise a single colluding member could re-admit anyone we kicked.
      const forwarderMembership = await this.#getMembership(op.groupId, sender);
      if (!forwarderMembership || forwarderMembership.state !== "active") {
        this.logger.warn(
          "[ServerGroupsService] dropping forwarded member.join from non-member "
            + sender + " for group " + op.groupId,
        );
        return;
      }
      if (wasRemoved) {
        this.logger.warn(
          "[ServerGroupsService] dropping forwarded member.join for removed member " + joiner
            + ": forwards cannot resurrect a kicked member (group " + op.groupId + ")",
        );
        return;
      }
    }

    // Apply locally. We deliberately do NOT call ensureGroupThread here — that
    // helper is the full bootstrap path run when the LOCAL owner joins a group
    // (it re-asserts the owner's membership and emits extra events). By the
    // time we receive member.join we already have the group + thread locally.
    // Revival is an explicit, authorized transition (never a side effect of
    // ensureMembership); a brand-new joiner is added.
    let changed = false;
    if (wasRemoved) {
      const { revived } = await this.#groupStore.reviveMembership({
        ownerAccountId: this.ownerAccountId,
        groupId: op.groupId,
        accountId: joiner,
        role: "member",
      }).catch(() => ({ revived: false }));
      changed = revived;
    } else {
      const { created } = await this.#groupStore.ensureMembership({
        ownerAccountId: this.ownerAccountId,
        groupId: op.groupId,
        accountId: joiner,
        role: "member",
      }).catch(() => ({ created: false }));
      changed = created;
    }

    if (changed) {
      await this.#emitMembersUpdated(op.groupId);
      await this.#persistJoinSystemMessage({
        groupId: op.groupId,
        actorAccountId: joiner,
        actorDisplayName: typeof op.displayName === "string" ? op.displayName : "",
        actedAtMs: op.actedAtMs,
        groupOpId: op.groupOpId,
      });
    }

    if (shouldForward) {
      // Shape B fan-out: forward the joiner's announcement to every
      // other active member (excluding the joiner themselves and the
      // owner). Op bytes are unchanged so receivers see the same
      // groupOpId and de-duplicate by it.
      const others = await this.#listOtherActiveMembers(op.groupId);
      const forwardTargets = others.filter((acct) => acct !== joiner);
      if (forwardTargets.length > 0) {
        await this.#fanOutGroupOp({ targets: forwardTargets, payload: op });
      }
      // Catch-up: the inviter is the only side with a direct peer-link
      // to the joiner, so we are responsible for replaying our existing
      // channels into their channel store. The receiver upserts
      // idempotently. This used to live in the peer-link.updated handler
      // but membership semantics no longer ride on peer-link records.
      const channelsService = this.bus.services && this.bus.services.channels;
      if (channelsService && typeof channelsService.fanoutChannelsToPeer === "function") {
        await channelsService.fanoutChannelsToPeer({
          groupId: op.groupId,
          peerAccountId: joiner,
        }).catch((err) => {
          this.logger.warn("[ServerGroupsService] channels catch-up to joiner failed",
            err && err.message ? err.message : err);
        });
      }
    }
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
    const payload = new GroupOpPayloadV1({
      op: "member.join",
      groupId: gid,
      accountId: this.ownerAccountId,
      inviteId: id,
      displayName: typeof displayName === "string" ? displayName : "",
      actedAtMs: this.#clock(),
      groupOpId: nowOpId(),
    });
    await this.#fanOutGroupOp({ targets: [inviter], payload });
  }

  // Resolve + structurally validate the local invite envelope authorizing a
  // self-announced join (we are the inviter). Returns the signed envelope (so
  // the caller can read its createdAtMs for the anti-resurrection check) or
  // null if no matching active invite for this group exists.
  async #resolveJoinInviteEnvelope({ inviteId, groupId } = {}) {
    const peerLinks = this.bus.runtime && this.bus.runtime.peerLinks ? this.bus.runtime.peerLinks : null;
    if (!peerLinks || typeof peerLinks.getStoredInviteEnvelope !== "function") return null;
    const lookup = await peerLinks.getStoredInviteEnvelope(this.ownerAccountId, inviteId).catch(() => null);
    if (!lookup || !lookup.envelope) return null;
    const envelope = lookup.envelope;
    if (envelope.kind !== "group") return null;
    const envGroupId = typeof envelope.groupId === "string" ? envelope.groupId.trim() : "";
    if (envGroupId !== groupId) return null;
    return envelope;
  }

  async #persistJoinSystemMessage({ groupId, actorAccountId, actorDisplayName, actedAtMs, groupOpId } = {}) {
    const threadId = this.bus.services && this.bus.services.threads
      && typeof this.bus.services.threads.groupThreadId === "function"
      ? this.bus.services.threads.groupThreadId(groupId)
      : null;
    if (!threadId) return;
    const messageId = "sys:join:" + groupOpId;
    const payload = {
      kind: SYSTEM_EVENT_KIND,
      event: "member.join",
      groupId,
      actorAccountId,
      actorDisplayName: typeof actorDisplayName === "string" ? actorDisplayName : "",
      actedAtMs,
    };
    await this.#threadStore.upsertMessage({
      messageId,
      threadId,
      groupId,
      senderAccountId: null,
      senderKey: "system",
      payload,
      text: "",
      status: "delivered",
      createdAtMs: actedAtMs,
      acceptedAtMs: actedAtMs,
    }).catch((err) => {
      this.logger.warn("[ServerGroupsService] system join message persist failed",
        err && err.message ? err.message : err);
    });
  }

  async #getMembership(groupId, accountId) {
    if (!groupId || !accountId) return null;
    const members = await this.#groupStore.listMembers({
      ownerAccountId: this.ownerAccountId,
      groupId,
    }).catch(() => []);
    const list = Array.isArray(members) ? members : [];
    return list.find((m) => {
      const id = String(m && (m.accountId || m.accountId) || "").trim();
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
      const id = String(m && (m.accountId || m.accountId) || "").trim();
      const state = String(m && m.state || "active").toLowerCase();
      if (!id || id === this.ownerAccountId || state !== "active") continue;
      out.push(id);
    }
    return out;
  }

  async #fanOutGroupOp({ targets, payload } = {}) {
    if (!Array.isArray(targets) || targets.length === 0) return;
    const sdk = this.bus.runtime ? this.bus.runtime.sdk : null;
    if (!sdk || typeof sdk.sealForPeer !== "function" || !sdk.mesh) {
      this.logger.warn("[ServerGroupsService] sdk unavailable, skipping group-op fan-out");
      return;
    }
    const bodyBytes = groupOpPayloadToBytes(payload);
    await Promise.allSettled(targets.map((accountId) =>
      sdk.sealForPeer({
        peerAccountId: accountId,
        plaintextBodyBytes: bodyBytes,
      }).then((sealed) => sdk.mesh.dispatch(
        sealed.object,
        sealed.address,
      )).catch((err) => {
        this.logger.warn(
          "[ServerGroupsService] group-op fan-out to " + accountId + " failed",
          err && err.message ? err.message : err,
        );
      })
    ));
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
