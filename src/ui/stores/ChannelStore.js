import { StoreBase } from "./StoreBase.js";
import { ChatChannel, nonEmptyString, sortChannelsAlpha } from "../../records/index.js";

function asChannel(value) {
  if (value instanceof ChatChannel) return value;
  try {
    return new ChatChannel(value);
  } catch (err) {
    console.warn("[ChannelStore] dropped malformed channel row:", err && err.message ? err.message : err);
    return null;
  }
}

/**
 * ChannelStore (renderer): per-group channel records mirrored from the
 * server. `#general` is NOT stored here — it is a UI-synthesized row that
 * the sidebar/composer always renders for any group regardless of whether
 * any other channels exist.
 *
 * Live state: keyed `groupId → Map<channelId, ChatChannel>`. Tombstoned
 * channels (with `deletedAtMs !== null`) are kept in the map so the UI
 * can hide them while preserving the record for downstream queries.
 */
export class ChannelStore extends StoreBase {
  #byGroup;
  #loadedGroups;

  constructor({ bus = null } = {}) {
    super({ storeName: "channels", defaultSource: "ChannelStore", bus });
    this.#byGroup = new Map();
    this.#loadedGroups = new Set();
  }

  reset() {
    this.#byGroup.clear();
    this.#loadedGroups.clear();
    this._emit("channels.reset");
  }

  isLoaded(groupId) {
    const id = nonEmptyString(groupId);
    if (!id) return false;
    return this.#loadedGroups.has(id);
  }

  getChannels(groupId) {
    const id = nonEmptyString(groupId);
    if (!id) return [];
    const byChannel = this.#byGroup.get(id);
    if (!byChannel) return [];
    const active = [];
    for (const ch of byChannel.values()) {
      if (ch.deletedAtMs == null) active.push(ch);
    }
    return sortChannelsAlpha(active);
  }

  getChannel(groupId, channelId) {
    const gid = nonEmptyString(groupId);
    const cid = nonEmptyString(channelId);
    if (!gid || !cid) return null;
    const byChannel = this.#byGroup.get(gid);
    if (!byChannel) return null;
    return byChannel.get(cid) || null;
  }

  replaceChannels(groupId, channels = []) {
    const id = nonEmptyString(groupId);
    if (!id) return;
    const next = new Map();
    for (const raw of Array.isArray(channels) ? channels : []) {
      const record = asChannel(raw);
      if (!record || !record.channelId || record.groupId !== id) continue;
      next.set(record.channelId, record);
    }
    this.#byGroup.set(id, next);
    this.#loadedGroups.add(id);
    this._emit("channels.replaced", { groupId: id });
  }

  upsertChannel(channel) {
    const record = asChannel(channel);
    if (!record || !record.channelId || !record.groupId) return;
    const byChannel = this.#byGroup.get(record.groupId) || new Map();
    byChannel.set(record.channelId, record);
    this.#byGroup.set(record.groupId, byChannel);
    this._emit("channels.upserted", { groupId: record.groupId, channelId: record.channelId });
  }

  removeChannel(groupId, channelId) {
    const gid = nonEmptyString(groupId);
    const cid = nonEmptyString(channelId);
    if (!gid || !cid) return;
    const byChannel = this.#byGroup.get(gid);
    if (!byChannel) return;
    const existing = byChannel.get(cid);
    if (!existing) return;
    // Tombstone in place so historical references resolve, but the
    // sidebar (which calls getChannels) hides it.
    const tombstoned = asChannel({
      ...existing.toJSON(),
      deletedAtMs: Date.now(),
    });
    if (!tombstoned) return;
    byChannel.set(cid, tombstoned);
    this._emit("channels.removed", { groupId: gid, channelId: cid });
  }

  // Own-data accessors only. Selection (UiStateStore), display label
  // composition, and unread counts (ThreadStore.unreadByChannelId) live
  // elsewhere — see src/ui/queries/channelQueries.js + ThreadStore.
}
