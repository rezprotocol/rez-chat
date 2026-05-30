import { nonEmptyString } from "../../records/index.js";

/**
 * ChannelQueries: cross-store / multi-record channel answers.
 *
 * Unread counts are an own-data lookup on `thread.unreadByChannelId`,
 * so that accessor lives on ThreadStore (`ThreadStore.unreadCountFor`).
 */
export class ChannelQueries {
  #stores;

  constructor({ stores } = {}) {
    if (!stores) throw new Error("ChannelQueries requires { stores }");
    this.#stores = stores;
  }

  // Display label for a channel. Channels currently have no separate
  // label field — the id is the user-visible name. The canonical general-
  // channel id is the empty string (GENERAL_CHANNEL_ID); null/undefined/""
  // all resolve to the general label.
  displayLabel(groupId, channelId) {
    const cid = String(channelId == null ? "" : channelId).trim();
    if (!cid) return "general";
    const channels = this.#stores.channels;
    if (channels && typeof channels.getChannel === "function") {
      const ch = channels.getChannel(groupId, cid);
      if (ch && nonEmptyString(ch.label)) return ch.label;
    }
    return cid;
  }
}
