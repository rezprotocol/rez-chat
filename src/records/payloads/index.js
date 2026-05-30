/**
 * PAYLOAD_KIND_REGISTRY: single source of truth for every `"rez.*.v*"`
 * encrypted-deposit body kind that flows through ServerEventService's
 * mailbox-deposit pipeline.
 *
 * Each entry declares:
 *   - `kind`         — the wire string (e.g. "rez.chat.message.v1")
 *   - `recordClass`  — the RRecord subclass that owns this kind's shape.
 *                      Constructing `new recordClass(rawPayload)` validates
 *                      and throws on malformed input.
 *   - `dispatch`     — async (record, ctx, services) → boolean. Routes the
 *                      validated payload to its handler service. Returns
 *                      `true` when consumed (pipeline stops); `false` to
 *                      fall through to the default message-deposited path.
 *
 * Adding a new kind: build a *PayloadV1 record (extends RRecord, validates
 * required fields, exports the KIND constant), import it here, append an
 * entry.
 *
 * Guardrail: `no-orphan-payload-kind` (in `guardrails.config.json`) fails
 * the build if any `"rez.X.vN"` literal appears outside this directory or
 * an explicit allowlist (e.g. the protocol-layer peerlink kinds).
 */

import { ChatMessagePayloadV1, MESSAGE_KIND } from "./ChatMessagePayloadV1.js";
import { ChatReactionPayloadV1, REACTION_KIND } from "./ChatReactionPayloadV1.js";
import { ChatMessageEditPayloadV1, MESSAGE_EDIT_KIND } from "./ChatMessageEditPayloadV1.js";
import { ChatMessageTombstonePayloadV1, MESSAGE_TOMBSTONE_KIND } from "./ChatMessageTombstonePayloadV1.js";
import { GroupOpPayloadV1, GROUP_OP_KIND } from "./GroupOpPayloadV1.js";
import { ChatImagePayloadV1, IMAGE_KIND } from "./ChatImagePayloadV1.js";
import { ChatAvatarPayloadV1, AVATAR_KIND } from "./ChatAvatarPayloadV1.js";
import { ChatSystemEventPayloadV1, SYSTEM_EVENT_KIND } from "./ChatSystemEventPayloadV1.js";
import { FileManifestV1, FileChunkV1 } from "@rezprotocol/sdk/filetransfer";
import { ProfilePayloadV1 } from "@rezprotocol/sdk/profile";

export const FILE_MANIFEST_KIND = "rez.file.manifest.v1";
export const FILE_CHUNK_KIND = "rez.file.chunk.v1";
export const PROFILE_KIND = "rez.profile.v1";

export {
  ChatMessagePayloadV1,
  ChatReactionPayloadV1,
  ChatMessageEditPayloadV1,
  ChatMessageTombstonePayloadV1,
  GroupOpPayloadV1,
  ChatImagePayloadV1,
  ChatAvatarPayloadV1,
  ChatSystemEventPayloadV1,
  FileManifestV1,
  FileChunkV1,
  ProfilePayloadV1,
  MESSAGE_KIND,
  REACTION_KIND,
  MESSAGE_EDIT_KIND,
  MESSAGE_TOMBSTONE_KIND,
  GROUP_OP_KIND,
  IMAGE_KIND,
  AVATAR_KIND,
  SYSTEM_EVENT_KIND,
};

function extractPayloadSender(record, ctx) {
  if (ctx && typeof ctx.peerAccountId === "string" && ctx.peerAccountId.trim()) {
    return ctx.peerAccountId.trim();
  }
  if (record && typeof record.senderAccountId === "string" && record.senderAccountId) {
    return record.senderAccountId;
  }
  return "";
}

const ENTRIES = [
  {
    kind: MESSAGE_KIND,
    recordClass: ChatMessagePayloadV1,
    // Primary outbound message — falls through to the default
    // message-deposited persistence path in ServerEventService.
    async dispatch() { return false; },
  },
  {
    kind: REACTION_KIND,
    recordClass: ChatReactionPayloadV1,
    async dispatch(record, ctx, services) {
      if (!ctx || !ctx.threadId) return false;
      const messagesService = services && services.messages;
      if (!messagesService || typeof messagesService.handleIncomingReaction !== "function") return false;
      const consumed = await messagesService.handleIncomingReaction(record, {
        senderAccountId: extractPayloadSender(record, ctx),
        threadId: ctx.threadId,
      });
      return Boolean(consumed);
    },
  },
  {
    kind: MESSAGE_EDIT_KIND,
    recordClass: ChatMessageEditPayloadV1,
    async dispatch(record, ctx, services) {
      if (!ctx || !ctx.threadId) return false;
      const messagesService = services && services.messages;
      if (!messagesService || typeof messagesService.handleIncomingEdit !== "function") return false;
      const consumed = await messagesService.handleIncomingEdit(record, {
        senderAccountId: extractPayloadSender(record, ctx),
        threadId: ctx.threadId,
      });
      return Boolean(consumed);
    },
  },
  {
    kind: MESSAGE_TOMBSTONE_KIND,
    recordClass: ChatMessageTombstonePayloadV1,
    async dispatch(record, ctx, services) {
      if (!ctx || !ctx.threadId) return false;
      const messagesService = services && services.messages;
      if (!messagesService || typeof messagesService.handleIncomingTombstone !== "function") return false;
      const consumed = await messagesService.handleIncomingTombstone(record, {
        senderAccountId: extractPayloadSender(record, ctx),
        threadId: ctx.threadId,
      });
      return Boolean(consumed);
    },
  },
  {
    kind: GROUP_OP_KIND,
    recordClass: GroupOpPayloadV1,
    async dispatch(record, ctx, services) {
      const groupsService = services && services.groups;
      if (!groupsService || typeof groupsService.handleIncomingGroupOp !== "function") return false;
      const consumed = await groupsService.handleIncomingGroupOp(record, {
        senderAccountId: extractPayloadSender(record, ctx),
      });
      return Boolean(consumed);
    },
  },
  {
    kind: FILE_MANIFEST_KIND,
    recordClass: FileManifestV1,
    async dispatch(record, ctx, services) {
      const ft = services && services.fileTransfer;
      if (!ft || typeof ft.handleIncomingPayload !== "function") return false;
      const consumed = await ft.handleIncomingPayload(record, {
        senderAccountId: extractPayloadSender(record, ctx),
        threadId: ctx && ctx.threadId,
        channelId: ctx && typeof ctx.channelId === "string" ? ctx.channelId : "",
      });
      return Boolean(consumed);
    },
  },
  {
    kind: FILE_CHUNK_KIND,
    recordClass: FileChunkV1,
    async dispatch(record, ctx, services) {
      const ft = services && services.fileTransfer;
      if (!ft || typeof ft.handleIncomingPayload !== "function") return false;
      const consumed = await ft.handleIncomingPayload(record, {
        senderAccountId: extractPayloadSender(record, ctx),
        threadId: ctx && ctx.threadId,
        channelId: ctx && typeof ctx.channelId === "string" ? ctx.channelId : "",
      });
      return Boolean(consumed);
    },
  },
  {
    kind: AVATAR_KIND,
    recordClass: ChatAvatarPayloadV1,
    async dispatch(record, ctx, services) {
      const ft = services && services.fileTransfer;
      if (!ft || typeof ft.storeFile !== "function") return true;
      await ft.storeFile(record.fileHashHex, record.fileDataB64);
      return true;
    },
  },
  {
    kind: PROFILE_KIND,
    recordClass: ProfilePayloadV1,
    async dispatch(record, ctx, services) {
      const profileService = services && services.profile;
      if (!profileService || typeof profileService.handleIncomingProfile !== "function") return false;
      const consumed = await profileService.handleIncomingProfile(record, {
        senderAccountId: extractPayloadSender(record, ctx),
      });
      return Boolean(consumed);
    },
  },
];

export const PAYLOAD_KIND_REGISTRY = Object.freeze(
  Object.fromEntries(ENTRIES.map((entry) => [entry.kind, Object.freeze(entry)])),
);

export function getPayloadEntry(kind) {
  if (typeof kind !== "string") return null;
  return PAYLOAD_KIND_REGISTRY[kind] || null;
}

export function knownPayloadKinds() {
  return Object.keys(PAYLOAD_KIND_REGISTRY);
}
