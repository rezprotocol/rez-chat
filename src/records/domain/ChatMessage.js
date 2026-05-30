import { RRecord } from "@rezprotocol/sdk/client";
import { nonEmptyString, toFiniteNumber } from "./coerce.js";

export const MESSAGE_STATUSES = Object.freeze(["pending", "queued", "sent", "delivered", "failed"]);
const VALID_MESSAGE_STATUSES = new Set(MESSAGE_STATUSES);

function coerceStatus(value) {
  const trimmed = nonEmptyString(value) || "delivered";
  if (!VALID_MESSAGE_STATUSES.has(trimmed)) {
    throw new Error(`ChatMessage.status must be one of ${MESSAGE_STATUSES.join("|")}, got ${trimmed}`);
  }
  return trimmed;
}

export function coerceReactions(value) {
  if (!value || typeof value !== "object") return {};
  const out = {};
  for (const key of Object.keys(value)) {
    const emoji = String(key || "").trim();
    if (!emoji) continue;
    const raw = value[key];
    if (!Array.isArray(raw)) continue;
    const seen = new Set();
    const senders = [];
    for (const item of raw) {
      const id = String(item || "").trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      senders.push(id);
    }
    if (senders.length > 0) out[emoji] = senders;
  }
  return out;
}

/**
 * Canonical chat message record. Used everywhere a chat message is
 * passed — bus, storage, UI, presenters. If you have a `ChatMessage`,
 * you have all fields below; absent / unknown values are `null` (or
 * `""` / `{}` for string / object fields).
 *
 * Construction is strict: `new ChatMessage(raw)` validates and throws
 * on missing required fields. Callers that read untrusted input (KV
 * deserialization, wire decryption) MUST catch at the trust boundary;
 * everywhere else, just construct.
 *
 * No alias fields, no fallback chains. Pass the canonical names.
 */
export class ChatMessage extends RRecord {
  static type = "chat.message";

  constructor(raw = {}) {
    super();
    // --- identity ---
    this.threadId = nonEmptyString(raw.threadId);
    this.messageId = nonEmptyString(raw.messageId);

    // --- authorship ---
    this.senderAccountId = nonEmptyString(raw.senderAccountId);
    // speakerId is the UI-attribution identifier. Defaults to
    // senderAccountId; presenters override for DM cases where the wire
    // payload's senderAccountId is empty and peer-link context is the
    // source of truth.
    this.speakerId = nonEmptyString(raw.speakerId) || this.senderAccountId;
    this.inferredNotMine = raw.inferredNotMine === true;

    // --- storage-layer fields ---
    // senderKey: the local key identifying who deposited this row, used
    // for idempotency hashing. For outbound rows = ownerAccountId; for
    // inbound = peer's accountId.
    this.senderKey = nonEmptyString(raw.senderKey);
    this.packetB64 = nonEmptyString(raw.packetB64);

    // --- body ---
    this.status = coerceStatus(raw.status);
    this.text = typeof raw.text === "string" ? raw.text : "";
    this.payload = raw.payload && typeof raw.payload === "object" ? raw.payload : null;

    // --- timestamps ---
    this.createdAtMs = toFiniteNumber(raw.createdAtMs, Date.now());
    this.acceptedAtMs = raw.acceptedAtMs == null ? null : toFiniteNumber(raw.acceptedAtMs, this.createdAtMs);
    this.sentAtMs = raw.sentAtMs == null ? null : toFiniteNumber(raw.sentAtMs, 0);

    // --- mutations ---
    // inReplyToMessageId is wire-carried inside the payload but lifted to
    // a top-level column for cheap reply-header rendering. Lift from
    // payload if absent at top level so persistence paths don't have to
    // remember to denormalize.
    const explicitInReplyTo = nonEmptyString(raw.inReplyToMessageId);
    const payloadInReplyTo = this.payload ? nonEmptyString(this.payload.inReplyToMessageId) : "";
    this.inReplyToMessageId = explicitInReplyTo || payloadInReplyTo;
    this.editedAtMs = raw.editedAtMs == null ? null : toFiniteNumber(raw.editedAtMs, 0);
    this.tombstonedAtMs = raw.tombstonedAtMs == null ? null : toFiniteNumber(raw.tombstonedAtMs, 0);
    this.reactions = coerceReactions(raw.reactions);

    this._seal();
  }

  validate() {
    this.assert(this.messageId.length > 0, "ChatMessage requires messageId");
    this.assert(this.threadId.length > 0, "ChatMessage requires threadId");
  }
}
