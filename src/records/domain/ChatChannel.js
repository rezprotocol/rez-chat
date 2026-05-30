import { RRecord } from "@rezprotocol/sdk/client";
import { nonEmptyString, toFiniteNumber } from "./coerce.js";

/**
 * ChatChannel: a logical-organization tag within a group.
 *
 * A channel is purely a rez-chat-layer concept: messages tagged with a
 * `channelId` all flow over the single group thread, and the renderer
 * filters by tag. The implicit "#general" bucket is `channelId === ""`
 * and is NEVER persisted as a record — it is synthesized in the UI.
 *
 * A record is materialized either by an explicit `channel.create` group-op
 * (so members see empty channels) or by observing a non-empty `channelId`
 * on an inbound message. `deletedAtMs` carries a tombstone so historical
 * messages remain queryable while the channel disappears from the sidebar.
 */
export class ChatChannel extends RRecord {
  static type = "chat.channel";

  constructor(raw = {}) {
    super();
    this.channelId = nonEmptyString(raw.channelId);
    this.groupId = nonEmptyString(raw.groupId);
    this.ownerAccountId = nonEmptyString(raw.ownerAccountId);
    // Free-form display label. Optional — falls back to channelId in the UI.
    // Carries the user's original typing (case + spaces + emoji preserved).
    const rawLabel = raw.label == null ? "" : String(raw.label);
    this.label = rawLabel.length > 128 ? rawLabel.slice(0, 128) : rawLabel;
    const createdAtMs = raw.createdAtMs == null ? null : toFiniteNumber(raw.createdAtMs, 0);
    this.createdAtMs = createdAtMs;
    this.deletedAtMs = raw.deletedAtMs == null ? null : toFiniteNumber(raw.deletedAtMs, 0);
    this._seal();
  }

  validate() {
    this.assert(this.channelId.length > 0, "ChatChannel requires channelId");
    this.assert(this.groupId.length > 0, "ChatChannel requires groupId");
    this.assert(this.ownerAccountId.length > 0, "ChatChannel requires ownerAccountId");
  }
}

// Canonical sort: label-or-channelId case-insensitive, ties broken by raw
// channelId. Sorts in place and returns the list. Shared by the server-side
// ChatChannelStore and the renderer-side ChannelStore so both surfaces agree
// on channel order.
export function sortChannelsAlpha(list) {
  return list.sort((a, b) => {
    const aName = String(a.label || a.channelId);
    const bName = String(b.label || b.channelId);
    const cmp = aName.localeCompare(bName, undefined, { sensitivity: "base" });
    if (cmp !== 0) return cmp;
    return String(a.channelId).localeCompare(String(b.channelId));
  });
}
