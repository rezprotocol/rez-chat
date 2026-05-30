import { SchemaRecord } from "../SchemaRecord.js";

/**
 * ChatSystemEventPayloadV1: a locally-derived chat-timeline marker
 * (e.g. "Alice joined the group"). Persisted into the group thread as a
 * regular thread message but with this payload kind so the renderer can
 * style it as a centered system row instead of a bubble.
 *
 * NOT a wire kind: each side derives + persists its own copy when the
 * underlying state-change op (currently `GroupOpPayloadV1.member.join`)
 * is applied. There is no `dispatch` entry for it in the deposit
 * registry — anything carrying this kind on the wire is treated as
 * untrusted and ignored.
 *
 * Schema deliberately narrow: one `event` enum + the minimum context
 * needed to render a localized sentence client-side.
 *
 *   - event           "member.join"                    (only value in v1)
 *   - groupId         the group the event happened in
 *   - actorAccountId  the account whose state changed (e.g. who joined)
 *   - actorDisplayName optional cached display name for rendering
 *   - actedAtMs       authoritative timestamp of the underlying op
 */

export const SYSTEM_EVENT_KIND = "rez.chat.system-event.v1";

export const SYSTEM_EVENTS = Object.freeze(["member.join"]);

export class ChatSystemEventPayloadV1 extends SchemaRecord {
  static type = SYSTEM_EVENT_KIND;
  static schema = {
    kind: { type: "string", required: true, trim: true, default: SYSTEM_EVENT_KIND },
    event: { type: "enum", values: [...SYSTEM_EVENTS], required: true },
    groupId: { type: "string", required: true, trim: true },
    actorAccountId: { type: "string", required: true, trim: true },
    actorDisplayName: { type: "string", trim: false, maxLength: 128 },
    actedAtMs: { type: "int", required: true },
  };

  _beforeSchemaCoerce() {
    this.kind = SYSTEM_EVENT_KIND;
  }
}
