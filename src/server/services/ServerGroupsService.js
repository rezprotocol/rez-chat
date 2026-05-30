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
    const groupId = this.bus.services.threads.groupThreadId(
      this.ownerAccountId + ":" + now + ":" + randomUUID()
    ).replace(/^th_/, "grp_");
    const threadId = this.bus.services.threads.groupThreadId(groupId);
    await this.#groupStore.ensureGroup({
      ownerAccountId: this.ownerAccountId,
      groupId,
      createdBy: this.ownerAccountId,
      title: title || null,
    });
    await this.#groupStore.ensureMembership({
      ownerAccountId: this.ownerAccountId,
      groupId,
      accountId: this.ownerAccountId,
      role: "admin",
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

  // The founder (group.createdBy) is always admin regardless of how the
  // member row was persisted. Stamp role="admin" on the founder's row when
  // returning to callers, so display + downstream checks stay consistent.
  // Public so ServerThreadsService can apply the same rule to its own
  // members-updated emits — single source of truth for the founder rule.
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
      if (mid === founder && String(member.role || "").toLowerCase() !== ADMIN_ROLE) {
        out.push(new ChatGroupMember({ ...member.toJSON(), role: ADMIN_ROLE }));
      } else {
        out.push(member);
      }
    }
    return out;
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
    let shouldForward = false;
    if (isSelfAnnounce) {
      // Authorize via our local invite record. Only the inviter has it;
      // forward recipients skip this check (they trust the sender's
      // group membership).
      const ok = await this.#verifyJoinAgainstInvite({
        inviteId: op.inviteId,
        groupId: op.groupId,
      });
      if (!ok) {
        this.logger.warn(
          "[ServerGroupsService] dropping member.join from " + joiner
            + ": no matching local invite for group " + op.groupId,
        );
        return;
      }
      shouldForward = true;
    } else {
      const forwarderMembership = await this.#getMembership(op.groupId, sender);
      if (!forwarderMembership || forwarderMembership.state !== "active") {
        this.logger.warn(
          "[ServerGroupsService] dropping forwarded member.join from non-member "
            + sender + " for group " + op.groupId,
        );
        return;
      }
    }

    // Just add the joiner to our local groupStore. We deliberately do NOT
    // call ensureGroupThread here — that helper is the full bootstrap path
    // run when the LOCAL owner joins a group (it re-asserts the owner's
    // membership as "member" which would silently downgrade an admin and
    // always emits an extra group.members.updated). By the time we receive
    // member.join we already have the group + thread locally (either we
    // issued the invite, or we were added to the group when WE joined).
    const { created } = await this.#groupStore.ensureMembership({
      ownerAccountId: this.ownerAccountId,
      groupId: op.groupId,
      accountId: joiner,
      role: "member",
    }).catch(() => ({ created: false }));

    if (created) {
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

  async #verifyJoinAgainstInvite({ inviteId, groupId } = {}) {
    const peerLinks = this.bus.runtime && this.bus.runtime.peerLinks ? this.bus.runtime.peerLinks : null;
    if (!peerLinks || typeof peerLinks.getStoredInviteEnvelope !== "function") return false;
    const lookup = await peerLinks.getStoredInviteEnvelope(this.ownerAccountId, inviteId).catch(() => null);
    if (!lookup || !lookup.envelope) return false;
    const envelope = lookup.envelope;
    if (envelope.kind !== "group") return false;
    const envGroupId = typeof envelope.groupId === "string" ? envelope.groupId.trim() : "";
    return envGroupId === groupId;
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
    if (String(membership.role || "").toLowerCase() === ADMIN_ROLE) return true;
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
    if (!sdk || typeof sdk.sendEncryptedDeposit !== "function") {
      this.logger.warn("[ServerGroupsService] sdk unavailable, skipping group-op fan-out");
      return;
    }
    const bodyBytes = groupOpPayloadToBytes(payload);
    await Promise.allSettled(targets.map((accountId) =>
      sdk.sendEncryptedDeposit({
        peerAccountId: accountId,
        plaintextBodyBytes: bodyBytes,
      }).catch((err) => {
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
