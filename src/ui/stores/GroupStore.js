import { StoreBase } from "./StoreBase.js";
import { ChatGroup, ChatGroupMember, nonEmptyString } from "../../records/index.js";

function asGroup(value) {
  if (value instanceof ChatGroup) return value;
  try {
    return new ChatGroup(value);
  } catch (err) {
    console.warn("[GroupStore] dropped malformed group row:", err && err.message ? err.message : err);
    return null;
  }
}

function asGroupMember(groupId, value) {
  if (value instanceof ChatGroupMember) {
    if (value.groupId === groupId) return value;
    return new ChatGroupMember({ ...value.toJSON(), groupId });
  }
  const raw = value && typeof value === "object" ? value : {};
  try {
    return new ChatGroupMember({ ...raw, groupId });
  } catch (err) {
    console.warn("[GroupStore] dropped malformed member row:", err && err.message ? err.message : err);
    return null;
  }
}

export class GroupStore extends StoreBase {
  #groups;
  #membersByGroupId;
  #loaded;
  #membersLoaded;

  constructor({ bus = null } = {}) {
    super({ storeName: "groups", defaultSource: "GroupStore", bus });
    this.#groups = new Map();
    this.#membersByGroupId = new Map();
    this.#loaded = false;
    this.#membersLoaded = new Map();
  }

  reset() {
    this.#groups.clear();
    this.#membersByGroupId.clear();
    this.#loaded = false;
    this.#membersLoaded.clear();
    this._emit("groups.reset");
  }

  isLoaded() {
    return this.#loaded === true;
  }

  getGroups() {
    return [...this.#groups.values()];
  }

  getGroup(groupId) {
    const id = nonEmptyString(groupId);
    if (!id) return null;
    return this.#groups.get(id) || null;
  }

  replaceGroups(groups = []) {
    this.#groups.clear();
    for (const raw of Array.isArray(groups) ? groups : []) {
      const record = asGroup(raw);
      if (!record || !record.groupId) continue;
      this.#groups.set(record.groupId, record);
    }
    this.#loaded = true;
    this._emit("groups.replaced");
  }

  upsertGroup(group) {
    const record = asGroup(group);
    if (!record || !record.groupId) return;
    this.#groups.set(record.groupId, record);
    this._emit("groups.upserted", { groupId: record.groupId });
  }

  removeGroup(groupId) {
    const id = nonEmptyString(groupId);
    if (!id) return;
    const hadGroup = this.#groups.delete(id);
    const hadMembers = this.#membersByGroupId.delete(id);
    this.#membersLoaded.delete(id);
    if (hadGroup || hadMembers) {
      this._emit("groups.removed", { groupId: id });
    }
  }

  isMembersLoaded(groupId) {
    const id = nonEmptyString(groupId);
    if (!id) return false;
    return this.#membersLoaded.get(id) === true;
  }

  getMembers(groupId) {
    const id = nonEmptyString(groupId);
    if (!id) return [];
    return [...(this.#membersByGroupId.get(id) || [])];
  }

  isAdmin(groupId, accountId) {
    const gid = nonEmptyString(groupId);
    const acct = nonEmptyString(accountId);
    if (!gid || !acct) return false;
    // Founder is the implicit admin — derived from group.createdBy. This is
    // the single source of truth for "founder admin" and works even before
    // members.list has populated. Explicit promotions (group.setRole) still
    // come through the member.role field.
    const group = this.#groups.get(gid);
    if (group && nonEmptyString(group.createdBy) === acct) return true;
    const members = this.#membersByGroupId.get(gid) || [];
    const self = members.find((m) => m && m.accountId === acct);
    if (!self) return false;
    return String(self.role || "").toLowerCase() === "admin";
  }

  replaceMembers(groupId, members = []) {
    const id = nonEmptyString(groupId);
    if (!id) return;
    const next = [];
    for (const raw of Array.isArray(members) ? members : []) {
      const record = asGroupMember(id, raw);
      if (!record || !record.accountId) continue;
      next.push(record);
    }
    this.#membersByGroupId.set(id, next);
    this.#membersLoaded.set(id, true);
    this._emit("groupMembers.replaced", { groupId: id });
  }

  // ---- Own-data accessors ------------------------------------------------
  // These read only this store. Cross-store "who am I" derivations live in
  // src/ui/queries/groupQueries.js — never reach into SessionStore here.

  getMember(groupId, memberId) {
    const gid = nonEmptyString(groupId);
    const mid = nonEmptyString(memberId);
    if (!gid || !mid) return null;
    const members = this.#membersByGroupId.get(gid) || [];
    for (const m of members) {
      if (m && m.accountId === mid) return m;
    }
    return null;
  }

  getMemberIds(groupId) {
    const id = nonEmptyString(groupId);
    if (!id) return [];
    const members = this.#membersByGroupId.get(id) || [];
    const out = [];
    for (const m of members) {
      if (m && m.accountId) out.push(m.accountId);
    }
    return out;
  }
}
