import { randomUUID } from "node:crypto";
import {
  GroupUpdatedEvent,
  GroupRemovedEvent,
} from "../../records/index.js";
import { GroupOpPayloadV1 } from "../../records/payloads/GroupOpPayloadV1.js";
import { SYSTEM_EVENT_KIND } from "../../records/payloads/ChatSystemEventPayloadV1.js";

const CREATOR_ROLE = "creator";

function nowOpId() {
  return "gop_" + randomUUID().replace(/-/g, "");
}

/**
 * ServerGroupOpApplier: applies INBOUND group ops received from peers
 * (rename/kick/setRole/leave/member.join/group.state + channel-op routing).
 * This is the remote-mutation half of group management; the local directive
 * half (create/leave/rename/kick/setRole) stays on ServerGroupsService.
 *
 * Extracted from ServerGroupsService (FLOW_AUDIT 2026-06-07 finding #8).
 * Behavior is unchanged. The membership/role read helpers and the
 * members/group "updated" emits remain owned by ServerGroupsService (the local
 * ops use them too — single source of truth) and are injected here as bound
 * callbacks, alongside the shared ServerGroupBroadcaster. All authorization,
 * anti-resurrection, and creator-protection logic is preserved verbatim.
 */
export class ServerGroupOpApplier {
  #bus;
  #logger;
  #groupStore;
  #threadStore;
  #ownerAccountId;
  #clock;
  #broadcaster;
  #getMembership;
  #isCreator;
  #isEffectiveAdmin;
  #listOtherActiveMembers;
  #emitMembersUpdated;
  #emitGroupUpdated;
  #emit;

  constructor({
    bus,
    logger = console,
    groupStore,
    threadStore,
    ownerAccountId,
    clock = () => Date.now(),
    broadcaster,
    getMembership,
    isCreator,
    isEffectiveAdmin,
    listOtherActiveMembers,
    emitMembersUpdated,
    emitGroupUpdated,
    emit,
  } = {}) {
    if (!bus || !groupStore || !threadStore || !broadcaster) {
      throw new Error("ServerGroupOpApplier requires bus, group/thread stores, and a broadcaster");
    }
    this.#bus = bus;
    this.#logger = logger || console;
    this.#groupStore = groupStore;
    this.#threadStore = threadStore;
    this.#ownerAccountId = ownerAccountId;
    this.#clock = clock;
    this.#broadcaster = broadcaster;
    this.#getMembership = getMembership;
    this.#isCreator = isCreator;
    this.#isEffectiveAdmin = isEffectiveAdmin;
    this.#listOtherActiveMembers = listOtherActiveMembers;
    this.#emitMembersUpdated = emitMembersUpdated;
    this.#emitGroupUpdated = emitGroupUpdated;
    this.#emit = emit;
  }

  async handle(record, { senderAccountId } = {}) {
    // ServerEventService constructs the GroupOpPayloadV1 record at the
    // receive boundary; we just check the type and use it.
    if (!(record instanceof GroupOpPayloadV1)) return false;
    const sender = typeof senderAccountId === "string" ? senderAccountId.trim() : "";
    if (!sender) {
      this.#logger.warn("[ServerGroupsService] handleIncomingGroupOp: no sender, dropping op=" + (record && record.op));
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
      this.#logger.warn(
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
        this.#logger.warn("[ServerGroupsService] ignoring kick from non-admin " + sender);
        return true;
      }
      await this.#applyIncomingKick(op);
      return true;
    }
    if (op.op === "setRole") {
      if (!isAdmin) {
        this.#logger.warn("[ServerGroupsService] ignoring setRole from non-admin " + sender);
        return true;
      }
      await this.#applyIncomingSetRole(op);
      return true;
    }
    if (op.op === "leave") {
      if (op.accountId !== sender) {
        this.#logger.warn("[ServerGroupsService] ignoring leave with mismatched sender");
        return true;
      }
      await this.#applyIncomingLeave(op);
      return true;
    }
    if (op.op === "channel.create" || op.op === "channel.delete") {
      const channelsService = this.#bus.services && this.#bus.services.channels;
      if (!channelsService || typeof channelsService.applyIncomingOp !== "function") {
        this.#logger.warn("[ServerGroupsService] channel op received but channels service not registered");
        return true;
      }
      await channelsService.applyIncomingOp(op, { senderAccountId: sender, isAdmin });
      return true;
    }
    if (op.op === "channels.sync_request") {
      const channelsService = this.#bus.services && this.#bus.services.channels;
      if (!channelsService || typeof channelsService.fanoutChannelsToPeer !== "function") {
        this.#logger.warn("[ServerGroupsService] channels.sync_request received but channels service not registered");
        return true;
      }
      await channelsService.fanoutChannelsToPeer({
        groupId: op.groupId,
        peerAccountId: sender,
      }).catch((err) => {
        this.#logger.warn("[ServerGroupsService] channels.sync_request fanout failed",
          err && err.message ? err.message : err);
      });
      // Catch-up requesters also need current group state (title) that they
      // may have missed because they joined or were offline during rename
      // fan-out. We send an explicit `group.state` op for this — never a
      // synthesized rename. Receiver fills empty titles only; never
      // overwrites a non-empty local title.
      await this.#advertiseGroupStateToPeer({ groupId: op.groupId, peerAccountId: sender })
        .catch((err) => {
          this.#logger.warn("[ServerGroupsService] group.state advertise to " + sender + " failed",
            err && err.message ? err.message : err);
        });
      return true;
    }
    if (op.op === "group.state") {
      await this.#applyIncomingGroupState(op);
      return true;
    }
    if (op.op === "member.contact") {
      await this.#applyIncomingMemberContact(op);
      return true;
    }
    return true;
  }

  async #applyIncomingRename(op) {
    const existingGroup = await this.#groupStore.getGroup({
      ownerAccountId: this.#ownerAccountId,
      groupId: op.groupId,
    }).catch(() => null);
    if (existingGroup
        && Number.isFinite(Number(existingGroup.updatedAtMs))
        && Number(existingGroup.updatedAtMs) >= op.actedAtMs) {
      return;
    }
    const { group } = await this.#groupStore.renameGroup({
      ownerAccountId: this.#ownerAccountId,
      groupId: op.groupId,
      title: op.title,
    });
    if (group) {
      const threadId = this.#bus.services.threads.groupThreadId(op.groupId);
      await this.#threadStore.ensureThread({
        threadId,
        groupId: op.groupId,
        threadType: "group",
        title: op.title,
      }).catch((err) => {
        this.#logger.warn("[ServerGroupsService] thread title sync failed (incoming rename)", err);
      });
      this.#emit("group.updated", new GroupUpdatedEvent({ group }));
    }
  }

  /**
   * Catch-up advertisement of current group state to a peer requesting a
   * sync. Sends an explicit `group.state` op (NOT a rename). The receiver
   * fills its title only if currently empty — never overwrites. This is
   * distinct from rename, which is a user-initiated LWW mutation.
   */
  async #advertiseGroupStateToPeer({ groupId, peerAccountId } = {}) {
    if (!groupId || !peerAccountId || peerAccountId === this.#ownerAccountId) return;
    const group = await this.#groupStore.getGroup({
      ownerAccountId: this.#ownerAccountId,
      groupId,
    }).catch(() => null);
    if (!group) return;
    const title = typeof group.title === "string" ? group.title.trim() : "";
    if (!title) return;
    const actedAtMs = Number.isFinite(Number(group.updatedAtMs))
      ? Number(group.updatedAtMs)
      : Number(group.createdAtMs) || this.#clock();
    await this.#broadcaster.fanOut({
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
      ownerAccountId: this.#ownerAccountId,
      groupId: op.groupId,
    }).catch(() => null);
    if (!existingGroup) return;
    const hasTitle = typeof existingGroup.title === "string"
      && existingGroup.title.trim().length > 0;
    if (hasTitle) return;
    const newTitle = typeof op.title === "string" ? op.title.trim() : "";
    if (!newTitle) return;
    const { group } = await this.#groupStore.renameGroup({
      ownerAccountId: this.#ownerAccountId,
      groupId: op.groupId,
      title: newTitle,
    });
    if (group) {
      const threadId = this.#bus.services.threads.groupThreadId(op.groupId);
      await this.#threadStore.ensureThread({
        threadId,
        groupId: op.groupId,
        threadType: "group",
        title: newTitle,
      }).catch((err) => {
        this.#logger.warn("[ServerGroupsService] thread title sync failed (group.state)", err);
      });
      this.#emit("group.updated", new GroupUpdatedEvent({ group }));
    }
  }

  async #applyIncomingKick(op) {
    // Authoritative creator protection on every receiving node: ignore a kick
    // targeting the group creator no matter who sent it (a compromised/colluding
    // admin could craft this op directly). Each node knows its own createdBy.
    if (await this.#isCreator(op.groupId, op.accountId)) {
      this.#logger.warn("[ServerGroupsService] ignoring kick targeting the group creator " + op.accountId);
      return;
    }
    const targetIsSelf = op.accountId === this.#ownerAccountId;
    const { removed } = await this.#groupStore.removeMember({
      ownerAccountId: this.#ownerAccountId,
      groupId: op.groupId,
      accountId: op.accountId,
    });
    if (!removed) return;
    if (targetIsSelf) {
      const threadId = this.#bus.services.threads.groupThreadId(op.groupId);
      await this.#threadStore.setThreadState({ threadId, accessState: "locked" }).catch((err) => {
        this.#logger.warn("[ServerGroupsService] thread lock failed after self-kick", err);
      });
      this.#emit("group.removed", new GroupRemovedEvent({ groupId: op.groupId }));
      return;
    }
    await this.#emitMembersUpdated(op.groupId);
    await this.#emitGroupUpdated(op.groupId);
  }

  async #applyIncomingSetRole(op) {
    // Authoritative creator protection: never let an inbound op change the
    // creator's role or mint a second creator, regardless of sender.
    if (await this.#isCreator(op.groupId, op.accountId)) {
      this.#logger.warn("[ServerGroupsService] ignoring setRole targeting the group creator " + op.accountId);
      return;
    }
    if (String(op.role || "").toLowerCase() === CREATOR_ROLE) {
      this.#logger.warn("[ServerGroupsService] ignoring setRole that would assign the creator role");
      return;
    }
    const { membership } = await this.#groupStore.setMemberRole({
      ownerAccountId: this.#ownerAccountId,
      groupId: op.groupId,
      accountId: op.accountId,
      role: op.role,
    });
    if (membership) {
      await this.#emitMembersUpdated(op.groupId);
    }
  }

  async #applyIncomingLeave(op) {
    if (op.accountId === this.#ownerAccountId) return;
    const { removed } = await this.#groupStore.removeMember({
      ownerAccountId: this.#ownerAccountId,
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
    if (joiner === this.#ownerAccountId) return;
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
        this.#logger.warn(
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
          this.#logger.warn(
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
      const peerLinks = this.#bus.runtime && this.#bus.runtime.peerLinks ? this.#bus.runtime.peerLinks : null;
      if (!peerLinks || typeof peerLinks.authorizeInviteJoin !== "function") {
        this.#logger.warn("[ServerGroupsService] member.join: peerLinks.authorizeInviteJoin unavailable");
        return;
      }
      const verdict = await peerLinks.authorizeInviteJoin({
        ownerAccountId: this.#ownerAccountId,
        inviteId: op.inviteId,
        joinerAccountId: joiner,
        nowMs: this.#clock(),
      }).catch((err) => {
        this.#logger.warn("[ServerGroupsService] member.join authorize failed",
          err && err.message ? err.message : err);
        return { authorized: false, reason: "AUTHORIZE_ERROR" };
      });
      if (!verdict || !verdict.authorized) {
        this.#logger.warn(
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
        this.#logger.warn(
          "[ServerGroupsService] dropping forwarded member.join from non-member "
            + sender + " for group " + op.groupId,
        );
        return;
      }
      if (wasRemoved) {
        this.#logger.warn(
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
    const joinerDisplayName = typeof op.displayName === "string" ? op.displayName : "";
    let changed = false;
    if (wasRemoved) {
      const { revived } = await this.#groupStore.reviveMembership({
        ownerAccountId: this.#ownerAccountId,
        groupId: op.groupId,
        accountId: joiner,
        role: "member",
        displayName: joinerDisplayName,
      }).catch(() => ({ revived: false }));
      changed = revived;
    } else {
      const { created } = await this.#groupStore.ensureMembership({
        ownerAccountId: this.#ownerAccountId,
        groupId: op.groupId,
        accountId: joiner,
        role: "member",
        displayName: joinerDisplayName,
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

    // The joiner is now an active member — re-apply any of their group messages
    // that arrived before this join and were deferred by the authz gate (the
    // offline push-before-member.join race). Safe regardless of `changed`: a
    // duplicate join still means the member is active, and the flush is a no-op
    // when nothing was deferred. See project_offline_push_before_handshake_race.
    const events = this.#bus && this.#bus.services ? this.#bus.services.events : null;
    if (events && typeof events.flushDeferredGroupMessages === "function") {
      await events.flushDeferredGroupMessages(op.groupId, joiner).catch((err) => {
        this.#logger.error("[ServerGroupsService] flush deferred group messages failed",
          err && err.message ? err.message : err);
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
        await this.#broadcaster.fanOut({ targets: forwardTargets, payload: op });
      }
      // Catch-up: the inviter is the only side with a direct peer-link
      // to the joiner, so we are responsible for replaying our existing
      // channels into their channel store. The receiver upserts
      // idempotently. This used to live in the peer-link.updated handler
      // but membership semantics no longer ride on peer-link records.
      const channelsService = this.#bus.services && this.#bus.services.channels;
      if (channelsService && typeof channelsService.fanoutChannelsToPeer === "function") {
        await channelsService.fanoutChannelsToPeer({
          groupId: op.groupId,
          peerAccountId: joiner,
        }).catch((err) => {
          this.#logger.warn("[ServerGroupsService] channels catch-up to joiner failed",
            err && err.message ? err.message : err);
        });
      }
      // Mesh bootstrap: we (the inviter) are the only side holding BOTH the new
      // joiner's inbox and the existing members' inboxes, so we advertise peer
      // routing to everyone. Each pair then establishes a direct peer-link by
      // re-inviting over the existing invite/accept path (member.contact handler →
      // bootstrapCoMemberLink), giving the joiner a full mesh rather than a link
      // only to us. See project_group_peerlinks_invite_tree_not_mesh.
      await this.#broadcastKnownContacts(op.groupId).catch((err) => {
        this.#logger.warn("[ServerGroupsService] member.contact broadcast on join failed",
          err && err.message ? err.message : err);
      });
    }
  }

  // Apply an inbound member.contact op: peer routing shared by an active member
  // so the rest of the group can MESH (every member needs a direct peer-link to
  // every other for fan-out). For each carried contact we (1) add the co-member
  // to our roster add-only (ensureMembership never resurrects a removed member —
  // anti-resurrection preserved; this is also how a transitively-invited member
  // first learns of pre-existing members) and (2) bootstrap a peer-link by
  // re-inviting the co-member. bootstrapCoMemberLink reuses the invite/accept
  // path and skips internally when a live/establishing link already exists, so
  // this is safe to call unconditionally. See project_group_peerlinks_invite_tree_not_mesh.
  async #applyIncomingMemberContact(op) {
    const contacts = Array.isArray(op.contacts) ? op.contacts : [];
    if (contacts.length === 0) return;
    const protocol = this.#bus.services && this.#bus.services.peerLinkProtocol
      ? this.#bus.services.peerLinkProtocol
      : null;
    let rosterChanged = false;
    for (const contact of contacts) {
      const acct = contact && typeof contact.accountId === "string" ? contact.accountId.trim() : "";
      const inbox = contact && typeof contact.inboxId === "string" ? contact.inboxId.trim() : "";
      if (!acct || !inbox || acct === this.#ownerAccountId) continue;
      const displayName = contact && typeof contact.displayName === "string" ? contact.displayName : "";
      const { membership, created } = await this.#groupStore.ensureMembership({
        ownerAccountId: this.#ownerAccountId,
        groupId: op.groupId,
        accountId: acct,
        role: "member",
        displayName,
      }).catch(() => ({ membership: null, created: false }));
      if (created) rosterChanged = true;
      const isActive = membership && String(membership.state || "").toLowerCase() === "active";
      // Never mesh with a member we hold as removed/left (don't undo a kick).
      if (isActive && protocol && typeof protocol.bootstrapCoMemberLink === "function") {
        // Fire-and-forget: establish a link with this co-member by re-inviting
        // them (skipped internally if a live/establishing link already exists).
        protocol.bootstrapCoMemberLink({ peerAccountId: acct, peerInboxId: inbox });
      }
    }
    if (rosterChanged) await this.#emitMembersUpdated(op.groupId);
  }

  // Build {accountId, inboxId, displayName} for every active member we hold a
  // routable peer-link for, and fan a member.contact op out to all active
  // members so they can mesh with each other. The inviter calls this on
  // member.join (it is the only side with the new joiner's inbox); reconcileMesh
  // calls it on connect to heal pre-existing tree-only groups. Recipients skip
  // their own entry. Idempotent.
  async #broadcastKnownContacts(groupId) {
    const inboxes = await this.#knownPeerInboxes();
    if (inboxes.size === 0) return;
    const members = await this.#groupStore.listMembers({
      ownerAccountId: this.#ownerAccountId,
      groupId,
    }).catch(() => []);
    const active = (Array.isArray(members) ? members : []).filter((m) =>
      m && m.state === "active" && m.accountId !== this.#ownerAccountId);
    const contacts = [];
    for (const member of active) {
      const inbox = inboxes.get(member.accountId);
      if (!inbox) continue;
      contacts.push({
        accountId: member.accountId,
        inboxId: inbox,
        displayName: typeof member.displayName === "string" ? member.displayName : "",
      });
    }
    if (contacts.length === 0) return;
    const targets = active.map((m) => m.accountId);
    if (targets.length === 0) return;
    const payload = new GroupOpPayloadV1({
      op: "member.contact",
      groupId,
      contacts,
      actedAtMs: this.#clock(),
      groupOpId: nowOpId(),
    });
    await this.#broadcaster.fanOut({ targets, payload });
  }

  // accountId → peerInboxId for every peer-link that carries a routable inbox
  // (the single source of truth for peer routing, per ServerPeerLinkProtocolService).
  async #knownPeerInboxes() {
    const map = new Map();
    const peerLinks = this.#bus.runtime && this.#bus.runtime.peerLinks ? this.#bus.runtime.peerLinks : null;
    if (!peerLinks || typeof peerLinks.listPeerLinks !== "function") return map;
    const result = await peerLinks.listPeerLinks({ ownerAccountId: this.#ownerAccountId }).catch(() => null);
    const items = result && Array.isArray(result.items) ? result.items : [];
    for (const item of items) {
      const acct = item && typeof item.peerAccountId === "string" ? item.peerAccountId.trim() : "";
      const inbox = item && typeof item.peerInboxId === "string" ? item.peerInboxId.trim() : "";
      if (acct && inbox) map.set(acct, inbox);
    }
    return map;
  }

  // Re-advertise known peer routing across every group on connect/reconnect so
  // members of a pre-existing tree-only group (created before mesh support) heal
  // into a full mesh. Idempotent and self-throttling — receivers no-op when a
  // link already exists. Public: ServerGroupsService wires it to start/reconnect.
  async reconcileMesh() {
    const groups = await this.#groupStore.listGroups({ ownerAccountId: this.#ownerAccountId }).catch(() => []);
    for (const group of (Array.isArray(groups) ? groups : [])) {
      await this.#broadcastKnownContacts(group.groupId).catch((err) => {
        this.#logger.warn("[ServerGroupsService] mesh reconcile failed for group " + group.groupId,
          err && err.message ? err.message : err);
      });
    }
  }

  // Resolve + structurally validate the local invite envelope authorizing a
  // self-announced join (we are the inviter). Returns the signed envelope (so
  // the caller can read its createdAtMs for the anti-resurrection check) or
  // null if no matching active invite for this group exists.
  async #resolveJoinInviteEnvelope({ inviteId, groupId } = {}) {
    const peerLinks = this.#bus.runtime && this.#bus.runtime.peerLinks ? this.#bus.runtime.peerLinks : null;
    if (!peerLinks || typeof peerLinks.getStoredInviteEnvelope !== "function") return null;
    const lookup = await peerLinks.getStoredInviteEnvelope(this.#ownerAccountId, inviteId).catch(() => null);
    if (!lookup || !lookup.envelope) return null;
    const envelope = lookup.envelope;
    if (envelope.kind !== "group") return null;
    const envGroupId = typeof envelope.groupId === "string" ? envelope.groupId.trim() : "";
    if (envGroupId !== groupId) return null;
    return envelope;
  }

  async #persistJoinSystemMessage({ groupId, actorAccountId, actorDisplayName, actedAtMs, groupOpId } = {}) {
    const threadId = this.#bus.services && this.#bus.services.threads
      && typeof this.#bus.services.threads.groupThreadId === "function"
      ? this.#bus.services.threads.groupThreadId(groupId)
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
      this.#logger.warn("[ServerGroupsService] system join message persist failed",
        err && err.message ? err.message : err);
    });
  }
}
