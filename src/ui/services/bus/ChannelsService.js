import { BaseBusService } from "./BaseBusService.js";
import { nonEmptyString } from "../../../records/index.js";

/**
 * ChannelsService (renderer): bus-side proxy for the server's
 * channels.{list,create,delete} directives and live mirror of
 * channel.upserted / channel.removed events.
 *
 * `#general` is NOT modeled here — sidebar/composer views render the
 * implicit "" channel themselves. This service only deals with the
 * named-channel records persisted server-side.
 */
export class ChannelsService extends BaseBusService {
  constructor({ bus, channelStore } = {}) {
    super({ bus });
    if (!channelStore) throw new Error("ChannelsService requires channelStore");
    this._channelStore = channelStore;
    this._register("channels", "ensureList", (payload) => this.ensureList(payload));
    this._register("channels", "list", (payload) => this.list(payload));
    this._register("channels", "create", (payload) => this.create(payload));
    this._register("channels", "delete", (payload) => this.delete(payload));
    this._register("channels", "syncAll", () => this.syncAll());
    this._listen("runtime.event.channel.upserted", (record) => this._handleChannelUpserted(record));
    this._listen("runtime.event.channel.removed", (record) => this._handleChannelRemoved(record));
    // The UI's hook into the single sync-all pathway. On each renderer
    // session connect (initial login + every lock/unlock) we ask the
    // server to walk every group and request a catch-up from every peer.
    // Receivers reply with channel records (carrying labels) AND an
    // explicit `group.state` op carrying the current title. The server
    // also fires this same pathway on its own `runtime.connected`; both
    // paths funnel into ServerChannelsService.requestSyncForAllMyGroups.
    this._listen("session.runtime.connected", () => {
      this.syncAll().catch((err) => {
        console.warn("[ChannelsService] session-connect syncAll failed",
          err && err.message ? err.message : err);
      });
    });
  }

  async syncAll() {
    const client = this._getClient();
    if (!client) return { requestsSent: 0 };
    return client.call("channels.syncAll", {});
  }

  _getClient() {
    return this.bus.runtime && this.bus.runtime.client ? this.bus.runtime.client : null;
  }

  async ensureList({ groupId, force = false } = {}) {
    const id = nonEmptyString(groupId);
    if (!id) return [];
    const client = this._getClient();
    if (!client) return this._channelStore.getChannels(id);
    if (!force && this._channelStore.isLoaded(id)) {
      return this._channelStore.getChannels(id);
    }
    const result = await client.call("channels.list", { groupId: id });
    const items = result && Array.isArray(result.items) ? result.items : [];
    this._channelStore.replaceChannels(id, items);
    this.bus.emit("channels.updated", { groupId: id });
    return this._channelStore.getChannels(id);
  }

  list({ groupId } = {}) {
    return this._channelStore.getChannels(groupId);
  }

  async create({ groupId, label, channelId } = {}) {
    const client = this._getClient();
    if (!client) throw new Error("ChannelsService: not connected");
    const gid = nonEmptyString(groupId);
    const labelText = typeof label === "string" ? label.trim() : "";
    const cid = nonEmptyString(channelId);
    if (!gid || (!labelText && !cid)) {
      throw new Error("ChannelsService.create: groupId and (label or channelId) required");
    }
    const wirePayload = { groupId: gid };
    if (labelText) wirePayload.label = labelText;
    if (cid) wirePayload.channelId = cid;
    const result = await client.call("channels.create", wirePayload);
    const channel = result && result.channel ? result.channel : null;
    if (channel) {
      this._channelStore.upsertChannel(channel);
      this.bus.emit("channels.updated", { groupId: gid, channelId: channel.channelId });
    }
    return result;
  }

  async delete({ groupId, channelId } = {}) {
    const client = this._getClient();
    if (!client) throw new Error("ChannelsService: not connected");
    const gid = nonEmptyString(groupId);
    const cid = nonEmptyString(channelId);
    if (!gid || !cid) throw new Error("ChannelsService.delete: groupId and channelId required");
    const result = await client.call("channels.delete", { groupId: gid, channelId: cid });
    if (result && result.deleted === true) {
      this._channelStore.removeChannel(gid, cid);
      this.bus.emit("channels.updated", { groupId: gid, channelId: cid });
    }
    return result;
  }

  _handleChannelUpserted(record) {
    const channel = record && record.channel ? record.channel : record;
    if (!channel || !channel.channelId || !channel.groupId) return;
    this._channelStore.upsertChannel(channel);
    this.bus.emit("channels.updated", { groupId: channel.groupId, channelId: channel.channelId });
  }

  _handleChannelRemoved(record) {
    const groupId = nonEmptyString(record && record.groupId);
    const channelId = nonEmptyString(record && record.channelId);
    if (!groupId || !channelId) return;
    this._channelStore.removeChannel(groupId, channelId);
    this.bus.emit("channels.updated", { groupId, channelId });
  }
}
