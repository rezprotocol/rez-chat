import { RRecord } from "@rezprotocol/sdk/client";
import { nonEmptyString, toFiniteNumber, uniqueStrings } from "./coerce.js";
import { coerceUnreadByChannelId } from "./ChatThreadIndexEntry.js";

export const THREAD_TYPES = Object.freeze({ DIRECT: "direct", GROUP: "group" });
const VALID_THREAD_TYPES = new Set(Object.values(THREAD_TYPES));

export const VISIBILITY_STATES = Object.freeze(["visible", "hidden"]);
const VALID_VISIBILITY = new Set(VISIBILITY_STATES);

export const ACCESS_STATES = Object.freeze(["open", "locked"]);
const VALID_ACCESS = new Set(ACCESS_STATES);

// Strict coercion: empty input → default; any other unknown value throws.
// Records do not silently rewrite invalid input to "looks plausible."
export function coerceThreadType(value, fallback = THREAD_TYPES.DIRECT) {
  if (value == null || value === "") return fallback;
  const text = String(value).toLowerCase().trim();
  if (text === "") return fallback;
  if (!VALID_THREAD_TYPES.has(text)) {
    throw new Error(`ChatThread.threadType must be 'direct' or 'group', got '${text}'`);
  }
  return text;
}

export function coerceVisibilityState(value, fallback = "visible") {
  if (value == null || value === "") return fallback;
  const text = String(value).toLowerCase().trim();
  if (text === "") return fallback;
  if (!VALID_VISIBILITY.has(text)) {
    throw new Error(`ChatThread.visibilityState must be 'visible' or 'hidden', got '${text}'`);
  }
  return text;
}

export function coerceAccessState(value, fallback = "open") {
  if (value == null || value === "") return fallback;
  const text = String(value).toLowerCase().trim();
  if (text === "") return fallback;
  if (!VALID_ACCESS.has(text)) {
    throw new Error(`ChatThread.accessState must be 'open' or 'locked', got '${text}'`);
  }
  return text;
}

export class ChatThread extends RRecord {
  static type = "chat.thread";

  constructor(raw = {}) {
    super();
    this.threadId = nonEmptyString(raw.threadId);
    this.threadType = coerceThreadType(raw.threadType);
    this.title = nonEmptyString(raw.title);
    this.displayTitle = nonEmptyString(raw.displayTitle);
    this.peerAccountId = nonEmptyString(raw.peerAccountId);
    this.groupId = nonEmptyString(raw.groupId);
    this.participants = uniqueStrings(raw.participants);
    this.visibilityState = coerceVisibilityState(raw.visibilityState);
    this.accessState = coerceAccessState(raw.accessState);
    this.peerInboxId = nonEmptyString(raw.peerInboxId);
    // Storage-layer timestamps (createdAtMs, updatedAtMs). lastActivityAtMs
    // is the bus/UI view of "most recent activity in this thread".
    const createdAtMs = raw.createdAtMs == null ? null : toFiniteNumber(raw.createdAtMs, 0);
    this.createdAtMs = createdAtMs;
    this.updatedAtMs = raw.updatedAtMs == null ? createdAtMs : toFiniteNumber(raw.updatedAtMs, createdAtMs || 0);
    this.lastActivityAtMs = raw.lastActivityAtMs == null
      ? (this.updatedAtMs == null ? null : this.updatedAtMs)
      : toFiniteNumber(raw.lastActivityAtMs, 0);
    this.lastActivityMsgId = nonEmptyString(raw.lastActivityMsgId);
    this.lastMessagePreview = raw.lastMessagePreview == null ? null : String(raw.lastMessagePreview);
    this.unreadCount = Math.max(0, Math.trunc(toFiniteNumber(raw.unreadCount, 0)));
    this.unreadByChannelId = coerceUnreadByChannelId(raw.unreadByChannelId);
    // threadReady and sendAllowed are ALWAYS booleans. They're derived from
    // the record's own structure (threadType + peerInboxId + peerAccountId +
    // accessState) so any consumer holding a ChatThread can trust them
    // without re-computing. If the caller passes an explicit override
    // (e.g. a presenter knows the peer-link is mid-handshake), that wins.
    this.threadReady = typeof raw.threadReady === "boolean"
      ? raw.threadReady
      : this.threadType === "group"
        ? true
        : (this.peerInboxId.length > 0 && this.peerAccountId.length > 0);
    this.sendAllowed = typeof raw.sendAllowed === "boolean"
      ? raw.sendAllowed
      : (this.threadReady && this.accessState !== "locked");
    this.securityState = nonEmptyString(raw.securityState) || "unknown";
    this.peerLinkState = nonEmptyString(raw.peerLinkState) || "";
    this._seal();
  }

  validate() {
    this.assert(this.threadId.length > 0, "ChatThread requires threadId");
    this.assert(VALID_THREAD_TYPES.has(this.threadType),
      "ChatThread.threadType must be 'direct' or 'group'");
  }
}
