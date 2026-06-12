import { BaseBusService } from "./BaseBusService.js";
import { nonEmptyString } from "../../../records/index.js";

export class InvitesService extends BaseBusService {
  constructor({ bus, inviteStore } = {}) {
    super({ bus });
    if (!inviteStore) {
      throw new Error("InvitesService requires inviteStore");
    }
    this._inviteStore = inviteStore;
    this._register("invites", "createDirect", (payload) => this.createDirect(payload));
    this._register("invites", "createGroup", (payload) => this.createGroup(payload));
    this._register("invites", "createForGroup", (payload) => this.createForGroup(payload));
    this._register("invites", "accept", (payload) => this.accept(payload));
    this._register("invites", "getLastCreatedCode", () => this._inviteStore.getLastCreatedInviteCode());
  }

  _getClient() {
    return this.bus.runtime && this.bus.runtime.client ? this.bus.runtime.client : null;
  }

  _getSelfLabel() {
    return this.bus.stores.session.selfLabel();
  }

  async createDirect({ maxUses = 1, creatorDisplayName = null } = {}) {
    const client = this._getClient();
    if (!client) return null;
    const name = creatorDisplayName || this._getSelfLabel();
    const created = await client.call("invite.create", {
      kind: "direct",
      maxUses,
      creatorDisplayName: name,
    });
    const code = created && created.inviteCode ? String(created.inviteCode) : "";
    this._inviteStore.setLastCreatedInviteCode(code);
    this.bus.emit("invites.updated", { inviteCode: code });
    return created;
  }

  async createGroup({ title = "New group", maxUses = 1 } = {}) {
    const client = this._getClient();
    if (!client) return null;
    const name = this._getSelfLabel();
    // Pass our display name so the server names the creator's membership row at
    // creation — the founder is named in their own roster immediately instead of
    // appearing as a bare account id until the first invite's self-proof lands.
    const createdGroup = await client.call("group.create", { title, creatorDisplayName: name });
    const groupId = createdGroup && createdGroup.groupId ? String(createdGroup.groupId) : "";
    const invite = await client.call("invite.create", {
      kind: "group", groupId, maxUses, creatorDisplayName: name, title,
    });
    const code = invite && invite.inviteCode ? String(invite.inviteCode) : "";
    this._inviteStore.setLastCreatedInviteCode(code);
    await this.bus.call("groups", "ensureList", { force: true });
    this.bus.emit("invites.updated", { inviteCode: code });
    return invite;
  }

  async createForGroup({ groupId, title = null, maxUses = 1 } = {}) {
    const client = this._getClient();
    const gid = nonEmptyString(groupId);
    if (!client || !gid) return null;
    let resolvedTitle = nonEmptyString(title);
    if (!resolvedTitle) {
      const groupStore = this.bus.stores && this.bus.stores.groups ? this.bus.stores.groups : null;
      const group = groupStore && typeof groupStore.getGroup === "function" ? groupStore.getGroup(gid) : null;
      resolvedTitle = group && group.title ? nonEmptyString(group.title) : "";
    }
    const name = this._getSelfLabel();
    const invite = await client.call("invite.create", {
      kind: "group",
      groupId: gid,
      maxUses,
      creatorDisplayName: name,
      title: resolvedTitle || null,
    });
    const code = invite && invite.inviteCode ? String(invite.inviteCode) : "";
    this._inviteStore.setLastCreatedInviteCode(code);
    this.bus.emit("invites.updated", { inviteCode: code });
    return invite;
  }

  async accept({ inviteCode, acceptorDisplayName = null } = {}) {
    const client = this._getClient();
    const code = nonEmptyString(inviteCode);
    if (!client || !code) return null;
    const name = acceptorDisplayName || this._getSelfLabel();
    const result = await client.call("invite.accept", { inviteCode: code, acceptorDisplayName: name });
    const nextThreadId = nonEmptyString(result && (result.groupThreadId || result.threadId));
    if (nextThreadId) {
      await this.bus.call("threads", "select", { threadId: nextThreadId });
    }
    return result;
  }
}
