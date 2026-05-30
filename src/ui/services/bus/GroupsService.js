import { BaseBusService } from "./BaseBusService.js";
import { nonEmptyString } from "../../../records/index.js";

export class GroupsService extends BaseBusService {
  constructor({ bus, groupStore } = {}) {
    super({ bus });
    if (!groupStore) throw new Error("GroupsService requires groupStore");
    this._groupStore = groupStore;
    this._register("groups", "ensureList", (payload) => this.ensureList(payload));
    this._register("groups", "get", (payload) => this.get(payload));
    this._register("groups", "ensureMembers", (payload) => this.ensureMembers(payload));
    this._register("groups", "getMembers", (payload) => this.getMembers(payload));
    this._register("groups", "leave", (payload) => this.leaveGroup(payload));
    this._register("groups", "rename", (payload) => this.rename(payload));
    this._register("groups", "kick", (payload) => this.kick(payload));
    this._register("groups", "setRole", (payload) => this.setRole(payload));
    this._listen("runtime.event.group.updated", (record) => this._handleGroupUpdated(record));
    this._listen("runtime.event.group.removed", (record) => this._handleGroupRemoved(record));
    this._listen("runtime.event.group.members.updated", (record) => this._handleGroupMembersUpdated(record));
  }

  _getClient() {
    return this.bus.runtime && this.bus.runtime.client ? this.bus.runtime.client : null;
  }

  async ensureList({ force = false } = {}) {
    const client = this._getClient();
    if (!client) return this._groupStore.getGroups();
    if (!force && this._groupStore.isLoaded()) {
      return this._groupStore.getGroups();
    }
    const result = await client.call("groups.list", {});
    const items = result && Array.isArray(result.items) ? result.items : [];
    this._groupStore.replaceGroups(items);
    this.bus.emit("groups.updated", {});
    return this._groupStore.getGroups();
  }

  get({ groupId } = {}) {
    return this._groupStore.getGroup(groupId);
  }

  async ensureMembers({ groupId, force = false } = {}) {
    const client = this._getClient();
    const id = nonEmptyString(groupId);
    if (!client || !id) return [];
    if (!force && this._groupStore.isMembersLoaded(id)) {
      return this._groupStore.getMembers(id);
    }
    const result = await client.call("group.members.list", { groupId: id });
    const items = result && Array.isArray(result.items) ? result.items : [];
    this._groupStore.replaceMembers(id, items);
    this.bus.emit("groupMembers.updated", { groupId: id });
    return this._groupStore.getMembers(id);
  }

  getMembers({ groupId } = {}) {
    return this._groupStore.getMembers(groupId);
  }

  async rename({ groupId, title } = {}) {
    const client = this._getClient();
    if (!client) throw new Error("GroupsService: not connected");
    const result = await client.call("group.rename", { groupId, title });
    const group = result && result.group ? result.group : null;
    if (group) {
      this._groupStore.upsertGroup(group);
      this.bus.emit("groups.updated", { groupId });
    }
    return result;
  }

  async kick({ groupId, accountId } = {}) {
    const client = this._getClient();
    if (!client) throw new Error("GroupsService: not connected");
    return client.call("group.kick", { groupId, accountId });
  }

  async setRole({ groupId, accountId, role } = {}) {
    const client = this._getClient();
    if (!client) throw new Error("GroupsService: not connected");
    return client.call("group.setRole", { groupId, accountId, role });
  }

  async leaveGroup({ groupId } = {}) {
    const client = this._getClient();
    if (!client) throw new Error("GroupsService: not connected");
    const result = await client.call("group.leave", { groupId });
    this._groupStore.removeGroup(groupId);
    this.bus.emit("groups.updated", { groupId });
    return result;
  }

  _handleGroupUpdated(record) {
    const group = record && record.group ? record.group : record;
    if (!group || !group.groupId) return;
    this._groupStore.upsertGroup(group);
    this.bus.emit("groups.updated", { groupId: group.groupId });
  }

  _handleGroupRemoved(record) {
    const groupId = nonEmptyString(record && record.groupId);
    if (!groupId) return;
    this._groupStore.removeGroup(groupId);
    this.bus.emit("groups.updated", { groupId });
  }

  _handleGroupMembersUpdated(record) {
    const groupId = nonEmptyString(record && record.groupId);
    if (!groupId) return;
    const members = record && Array.isArray(record.members) ? record.members : [];
    this._groupStore.replaceMembers(groupId, members);
    this.bus.emit("groupMembers.updated", { groupId });
  }
}
