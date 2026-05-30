import { asInt, requireId } from "./coerce.js";
import { KvTable } from "./KvTable.js";
import { ChatChannel, sortChannelsAlpha } from "../../records/domain/ChatChannel.js";
import { isValidChannelId } from "../../records/payloads/ChatMessagePayloadV1.js";

export const CHANNEL_PREFIX = "app:channels/";

/**
 * ChatChannelStore: per-owner-per-group set of channel records.
 *
 * Records persist only for *named* channels — the implicit "#general"
 * bucket (channelId === "") is synthesized in the UI and never stored.
 * A record is materialized either by an explicit channels.create directive
 * (or inbound channel.create group-op) or by observing a non-empty
 * channelId on an inbound message (see ServerMessagesService).
 *
 * Tombstone semantics: deletion sets `deletedAtMs` and the record stays in
 * KV so historical messages tagged with that channelId remain queryable.
 * `listChannels` filters tombstones by default; pass `{ includeDeleted: true }`
 * to see everything.
 */
export class ChannelStore {
  constructor({ storageProvider, clock = () => Date.now() } = {}) {
    if (!storageProvider || typeof storageProvider.getKeyValueStore !== "function") {
      throw new Error("ChannelStore requires storageProvider.getKeyValueStore()");
    }
    if (typeof clock !== "function") {
      throw new Error("ChannelStore requires clock function");
    }
    this.kv = storageProvider.getKeyValueStore(null);
    this.clock = clock;

    this.channels = new KvTable({
      kv: this.kv,
      prefix: CHANNEL_PREFIX,
      record: ChatChannel,
      label: "ChatChannelStore.channels",
      clock,
      hashParts: true,
      seedFn: (nowMs) => ({ createdAtMs: nowMs }),
      extraValidate: (record) => !!record.ownerAccountId,
    });
  }

  async ensureChannel({ ownerAccountId, groupId, channelId, label = null, createdAtMs = null } = {}) {
    const owner = requireId(ownerAccountId, "ownerAccountId");
    const gid = requireId(groupId, "groupId");
    const cid = requireId(channelId, "channelId");
    if (!isValidChannelId(cid)) {
      throw new Error(`ChannelStore.ensureChannel: invalid channelId '${cid}'`);
    }
    const labelOrEmpty = label == null ? "" : String(label);
    const existing = await this.channels.get(owner, gid, cid);
    if (existing) {
      if (existing.deletedAtMs == null) {
        // First-writer-wins for label: only fill in if missing. Avoids a
        // later observation-upsert (which has no label) clobbering the
        // original creator's display string.
        if (!existing.label && labelOrEmpty) {
          const merged = this.channels.coerce({
            ownerAccountId: owner,
            groupId: gid,
            channelId: cid,
            label: labelOrEmpty,
            createdAtMs: existing.createdAtMs,
            deletedAtMs: null,
          });
          if (!merged) throw new Error("ChannelStore.ensureChannel produced invalid row on label fill");
          await this.channels.set(merged, owner, gid, cid);
          return { channel: merged, created: false };
        }
        return { channel: existing, created: false };
      }
      // Re-creating a tombstoned channel revives it.
      const now = asInt(createdAtMs == null ? this.clock() : createdAtMs, Date.now());
      const revived = this.channels.coerce({
        ownerAccountId: owner,
        groupId: gid,
        channelId: cid,
        label: labelOrEmpty || existing.label,
        createdAtMs: now,
        deletedAtMs: null,
      });
      if (!revived) throw new Error("ChannelStore.ensureChannel produced invalid row on revive");
      await this.channels.set(revived, owner, gid, cid);
      return { channel: revived, created: true };
    }
    const now = asInt(createdAtMs == null ? this.clock() : createdAtMs, Date.now());
    const created = this.channels.coerce({
      ownerAccountId: owner,
      groupId: gid,
      channelId: cid,
      label: labelOrEmpty,
      createdAtMs: now,
      deletedAtMs: null,
    });
    if (!created) throw new Error("ChannelStore.ensureChannel produced invalid row");
    await this.channels.set(created, owner, gid, cid);
    return { channel: created, created: true };
  }

  async getChannel({ ownerAccountId, groupId, channelId } = {}) {
    const owner = requireId(ownerAccountId, "ownerAccountId");
    const gid = requireId(groupId, "groupId");
    const cid = requireId(channelId, "channelId");
    return this.channels.get(owner, gid, cid);
  }

  async listChannels({ ownerAccountId, groupId, includeDeleted = false } = {}) {
    const owner = requireId(ownerAccountId, "ownerAccountId");
    const gid = requireId(groupId, "groupId");
    const rows = await this.channels.list(owner, gid);
    const filtered = includeDeleted === true
      ? rows
      : rows.filter((r) => r.deletedAtMs == null);
    return sortChannelsAlpha(filtered);
  }

  async tombstoneChannel({ ownerAccountId, groupId, channelId, deletedAtMs = null } = {}) {
    const owner = requireId(ownerAccountId, "ownerAccountId");
    const gid = requireId(groupId, "groupId");
    const cid = requireId(channelId, "channelId");
    if (!isValidChannelId(cid)) {
      throw new Error(`ChannelStore.tombstoneChannel: invalid channelId '${cid}'`);
    }
    const existing = await this.channels.get(owner, gid, cid);
    if (!existing) return { channel: null, tombstoned: false };
    if (existing.deletedAtMs != null) return { channel: existing, tombstoned: false };
    const now = asInt(deletedAtMs == null ? this.clock() : deletedAtMs, Date.now());
    const next = this.channels.coerce({
      ownerAccountId: owner,
      groupId: gid,
      channelId: cid,
      label: existing.label,
      createdAtMs: existing.createdAtMs,
      deletedAtMs: now,
    });
    if (!next) throw new Error("ChannelStore.tombstoneChannel produced invalid row");
    await this.channels.set(next, owner, gid, cid);
    return { channel: next, tombstoned: true };
  }
}
