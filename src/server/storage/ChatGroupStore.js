import { asInt, requireId } from "./coerce.js";
import { KvTable } from "./KvTable.js";
import { ChatGroup } from "../../records/domain/ChatGroup.js";
import {
  ChatGroupMember,
  GROUP_ROLES,
  GROUP_MEMBER_STATES,
  coerceGroupRole,
} from "../../records/domain/ChatGroupMember.js";

export const GROUP_PREFIX = "app:groups/";
export const GROUP_INDEX_PREFIX = "app:groupIndex/";
const MEMBERSHIP_PREFIX = "app:groupMembership/";

// Re-exported for backward compatibility with tests/fixtures importing
// these from the storage module. New code should import from
// records/domain/ChatGroupMember.js.
export { GROUP_ROLES, GROUP_MEMBER_STATES };

function sortByUpdatedThen(list, secondaryField) {
  return list.sort((a, b) => {
    if (a.updatedAtMs !== b.updatedAtMs) return b.updatedAtMs - a.updatedAtMs;
    return String(a[secondaryField] || "").localeCompare(String(b[secondaryField] || ""));
  });
}

export class GroupStore {
  constructor({ storageProvider, clock = () => Date.now() } = {}) {
    if (!storageProvider || typeof storageProvider.getKeyValueStore !== "function") {
      throw new Error("GroupStore requires storageProvider.getKeyValueStore()");
    }
    if (typeof clock !== "function") {
      throw new Error("GroupStore requires clock function");
    }
    this.kv = storageProvider.getKeyValueStore(null);
    this.clock = clock;

    this.groups = new KvTable({
      kv: this.kv,
      prefix: GROUP_PREFIX,
      record: ChatGroup,
      label: "ChatGroupStore.groups",
      clock,
      hashParts: true,
      seedFn: (nowMs) => ({ createdAtMs: nowMs }),
      // ChatGroup record only validates groupId; store also requires owner.
      extraValidate: (record) => !!record.ownerAccountId,
    });
    this.memberships = new KvTable({
      kv: this.kv,
      prefix: MEMBERSHIP_PREFIX,
      record: ChatGroupMember,
      label: "ChatGroupStore.memberships",
      clock,
      hashParts: true,
      seedFn: (nowMs) => ({ joinedAtMs: nowMs }),
      extraValidate: (record) => !!record.ownerAccountId,
    });
  }

  async ensureGroup({ ownerAccountId, groupId, createdBy, title = null, joinedViaInviteId = null, creatorSalt = null } = {}) {
    const owner = requireId(ownerAccountId, "ownerAccountId");
    const id = requireId(groupId, "groupId");
    const creator = requireId(createdBy, "createdBy");
    const existing = await this.groups.get(owner, id);
    if (existing) return { group: existing, created: false };
    const now = asInt(this.clock(), Date.now());
    const created = this.groups.coerce({
      ownerAccountId: owner,
      groupId: id,
      createdAtMs: now,
      updatedAtMs: now,
      title,
      createdBy: creator,
      joinedViaInviteId: typeof joinedViaInviteId === "string" ? joinedViaInviteId.trim() : "",
      creatorSalt: typeof creatorSalt === "string" ? creatorSalt.trim() : "",
    });
    if (!created) throw new Error("ChatGroupStore.ensureGroup produced invalid row");
    await this.groups.set(created, owner, id);
    await this.kv.set(GROUP_INDEX_PREFIX + id, { ownerAccountId: owner, groupId: id });
    return { group: created, created: true };
  }

  async getGroup({ ownerAccountId, groupId } = {}) {
    const owner = requireId(ownerAccountId, "ownerAccountId");
    const id = requireId(groupId, "groupId");
    return this.groups.get(owner, id);
  }

  async listGroups({ ownerAccountId } = {}) {
    const owner = requireId(ownerAccountId, "ownerAccountId");
    return sortByUpdatedThen(await this.groups.list(owner), "groupId");
  }

  async ensureMembership({ ownerAccountId, groupId, accountId, role = "member", displayName = null } = {}) {
    const owner = requireId(ownerAccountId, "ownerAccountId");
    const gid = requireId(groupId, "groupId");
    const member = requireId(accountId, "accountId");
    const existing = await this.memberships.get(owner, gid, member);
    if (existing) return { membership: existing, created: false };
    const now = asInt(this.clock(), Date.now());
    const name = typeof displayName === "string" && displayName.trim() ? displayName.trim() : null;
    const created = this.memberships.coerce({
      ownerAccountId: owner,
      groupId: gid,
      accountId: member,
      role,
      state: "active",
      // Display-name hint carried on the join op (or supplied at create). The
      // inviter has no CONTACT for a joiner, so this membership field is the
      // only name source for the joiner's row in the inviter's roster.
      displayName: name,
      joinedAtMs: now,
      updatedAtMs: now,
    });
    if (!created) throw new Error("ChatGroupStore.ensureMembership produced invalid row");
    await this.memberships.set(created, owner, gid, member);
    return { membership: created, created: true };
  }

  /**
   * Explicitly revive a previously-removed member (kicked or left) back to
   * "active". This is a PRIVILEGED, EXPLICIT operation — deliberately separate
   * from ensureMembership, which must never resurrect a removed member as a
   * side effect (that was a security hole: a re-sent message/op silently
   * re-admitted kicked members). Callers must authorize the revival first
   * (e.g. against a fresh post-removal invite). No-op (revived:false) when the
   * row is absent or already active. Rejoin restores the supplied role.
   */
  async reviveMembership({ ownerAccountId, groupId, accountId, role = "member", displayName = null } = {}) {
    const owner = requireId(ownerAccountId, "ownerAccountId");
    const gid = requireId(groupId, "groupId");
    const member = requireId(accountId, "accountId");
    const existing = await this.memberships.get(owner, gid, member);
    if (!existing || String(existing.state || "").toLowerCase() !== "removed") {
      return { membership: existing || null, revived: false };
    }
    const now = asInt(this.clock(), Date.now());
    const name = typeof displayName === "string" && displayName.trim() ? displayName.trim() : null;
    const revived = this.memberships.coerce({
      ...existing.toJSON(),
      role,
      state: "active",
      // Refresh the name from the rejoin op when present; otherwise keep what
      // the prior membership carried (spread above).
      ...(name ? { displayName: name } : {}),
      updatedAtMs: now,
    });
    if (!revived) throw new Error("ChatGroupStore.reviveMembership produced invalid row");
    await this.memberships.set(revived, owner, gid, member);
    return { membership: revived, revived: true };
  }

  async getMembership({ ownerAccountId, groupId, accountId } = {}) {
    const owner = requireId(ownerAccountId, "ownerAccountId");
    const gid = requireId(groupId, "groupId");
    const member = requireId(accountId, "accountId");
    return this.memberships.get(owner, gid, member);
  }

  async listMembers({ ownerAccountId, groupId } = {}) {
    const owner = requireId(ownerAccountId, "ownerAccountId");
    const gid = requireId(groupId, "groupId");
    return sortByUpdatedThen(await this.memberships.list(owner, gid), "accountId");
  }

  async renameGroup({ ownerAccountId, groupId, title } = {}) {
    const owner = requireId(ownerAccountId, "ownerAccountId");
    const id = requireId(groupId, "groupId");
    const existing = await this.groups.get(owner, id);
    if (!existing) return { group: null, renamed: false };
    const newTitle = typeof title === "string" ? title.trim() : "";
    if (!newTitle) throw new Error("renameGroup requires non-empty title");
    const now = asInt(this.clock(), Date.now());
    const updated = this.groups.coerce({ ...existing.toJSON(), title: newTitle, updatedAtMs: now });
    await this.groups.set(updated, owner, id);
    return { group: updated, renamed: true };
  }

  async setMemberRole({ ownerAccountId, groupId, accountId, role } = {}) {
    const owner = requireId(ownerAccountId, "ownerAccountId");
    const gid = requireId(groupId, "groupId");
    const member = requireId(accountId, "accountId");
    const validRole = coerceGroupRole(role);
    const existing = await this.memberships.get(owner, gid, member);
    if (!existing) return { membership: null, updated: false };
    const now = asInt(this.clock(), Date.now());
    const next = this.memberships.coerce({ ...existing.toJSON(), role: validRole, updatedAtMs: now });
    await this.memberships.set(next, owner, gid, member);
    return { membership: next, updated: true };
  }

  async removeMember({ ownerAccountId, groupId, accountId } = {}) {
    const owner = requireId(ownerAccountId, "ownerAccountId");
    const gid = requireId(groupId, "groupId");
    const member = requireId(accountId, "accountId");
    const existing = await this.memberships.get(owner, gid, member);
    if (!existing) return { membership: null, removed: false };
    const now = asInt(this.clock(), Date.now());
    const next = this.memberships.coerce({ ...existing.toJSON(), state: "removed", updatedAtMs: now });
    await this.memberships.set(next, owner, gid, member);
    return { membership: next, removed: true };
  }
}
