import { nonEmptyString } from "../../records/index.js";

/**
 * GroupQueries: cross-store group-domain answers.
 *
 * Constructed once at ChatApp bootstrap with the renderer `stores` map.
 * Stateless — each method derives from current store state on the fly.
 * Stores are never mutated.
 */
export class GroupQueries {
  #stores;

  constructor({ stores } = {}) {
    if (!stores) throw new Error("GroupQueries requires { stores }");
    this.#stores = stores;
  }

  #selfChatAccountId() {
    const session = this.#stores.session;
    if (!session || typeof session.chatAccountId !== "function") return null;
    return session.chatAccountId();
  }

  isSelfAdmin(groupId) {
    const selfId = this.#selfChatAccountId();
    if (!selfId) return false;
    const groups = this.#stores.groups;
    if (!groups || typeof groups.isAdmin !== "function") return false;
    return groups.isAdmin(groupId, selfId);
  }

  selfMember(groupId) {
    const selfId = this.#selfChatAccountId();
    if (!selfId) return null;
    const groups = this.#stores.groups;
    if (!groups || typeof groups.getMember !== "function") return null;
    return groups.getMember(groupId, selfId);
  }

  canSelfRename(groupId) {
    return this.isSelfAdmin(groupId);
  }

  canSelfKick(groupId, memberId) {
    if (!this.isSelfAdmin(groupId)) return false;
    const mid = nonEmptyString(memberId);
    if (!mid) return false;
    const selfId = this.#selfChatAccountId();
    if (mid === selfId) return false;
    const groups = this.#stores.groups;
    if (!groups || typeof groups.getMember !== "function") return false;
    return groups.getMember(groupId, mid) != null;
  }

  // Same prerequisites as canSelfKick (admin viewer, not self, target is a
  // current member). Separate name so view gating reads with the right
  // intent at the call site.
  canSelfSetRole(groupId, memberId) {
    return this.canSelfKick(groupId, memberId);
  }

  canSelfDeleteChannel(groupId, channelId) {
    if (!this.isSelfAdmin(groupId)) return false;
    const cid = String(channelId == null ? "" : channelId).trim().toLowerCase();
    if (!cid || cid === "general") return false;
    return true;
  }

  canSelfCreateChannel(groupId) {
    return this.isSelfAdmin(groupId);
  }
}
