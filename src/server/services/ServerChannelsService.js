import { randomUUID } from "node:crypto";
import {
  ChannelsListParams,
  ChannelsListResult,
  ChannelsCreateParams,
  ChannelsCreateResult,
  ChannelsDeleteParams,
  ChannelsDeleteResult,
  ChannelsSyncAllResult,
  ChannelUpsertedEvent,
  ChannelRemovedEvent,
} from "../../records/index.js";
import { GroupOpPayloadV1, groupOpPayloadToBytes } from "../../records/payloads/GroupOpPayloadV1.js";
import { isValidChannelId, slugifyChannelLabel } from "../../records/payloads/ChatMessagePayloadV1.js";
import { BaseServerService } from "../base/BaseServerService.js";

function nowOpId() {
  return "gop_" + randomUUID().replace(/-/g, "");
}

/**
 * ServerChannelsService: owns the per-group channel set.
 *
 * Channels are a rez-chat-layer logical organization tag. Messages flow
 * unchanged over the group's single thread; the renderer filters by
 * `payload.channelId`. This service:
 *   - exposes channels.{list,create,delete} directives
 *   - fans out channel.{create,delete} ops via GroupOpPayloadV1 to all
 *     active group members so empty channels are visible and admin
 *     deletes propagate
 *   - applies inbound channel ops (routed in via
 *     ServerGroupsService.handleIncomingGroupOp)
 *   - exposes ensureFromObservedMessage(...) so the message receive path
 *     can materialize a channel record the moment a tagged message lands
 */
export class ServerChannelsService extends BaseServerService {
  #channelStore;
  #groupStore;
  #clock;

  constructor({
    bus,
    channelStore,
    groupStore,
    ownerAccountId,
    clock = () => Date.now(),
    logger = console,
  } = {}) {
    super({ bus, ownerAccountId, logger });
    if (!channelStore || !groupStore) {
      throw new Error("ServerChannelsService requires channel/group stores");
    }
    this.#channelStore = channelStore;
    this.#groupStore = groupStore;
    this.#clock = clock;
    this._register("channels", "list", (payload) => this.listChannels(payload));
    this._register("channels", "create", (payload) => this.createChannel(payload));
    this._register("channels", "delete", (payload) => this.deleteChannel(payload));
    this._register("channels", "syncAll", () => this.requestSyncForAllMyGroups());
    // Catch up on channels missed while this account was offline. On every
    // runtime.connected we walk our groups and ask each peer for a full
    // channel replay; receivers respond via fanoutChannelsToPeer (carrying
    // label), and ensureChannel is idempotent + first-writer-wins on label
    // so the catch-up does not clobber locally-known display strings.
    this._listen("runtime.connected", () => {
      this.requestSyncForAllMyGroups().catch((err) => {
        this.logger.warn("[ServerChannelsService] startup channel sync failed",
          err && err.message ? err.message : err);
      });
    });
  }

  async requestSyncForAllMyGroups() {
    const groups = await this.#groupStore.listGroups({
      ownerAccountId: this.ownerAccountId,
    }).catch(() => []);
    const list = Array.isArray(groups) ? groups : [];
    let requestsSent = 0;
    for (const group of list) {
      const gid = group && typeof group.groupId === "string" ? group.groupId.trim() : "";
      if (!gid) continue;
      const peers = await this.#listOtherActiveMembers(gid).catch(() => []);
      for (const peer of peers) {
        await this.#sendSyncRequest({ groupId: gid, peerAccountId: peer })
          .then(() => {
            requestsSent += 1;
          })
          .catch((err) => {
            this.logger.warn("[ServerChannelsService] sync_request to " + peer + " failed: "
              + (err && err.message ? err.message : err));
          });
      }
    }
    return new ChannelsSyncAllResult({ requestsSent });
  }

  async listChannels(payload = {}) {
    const params = this._coerceParams(payload, ChannelsListParams);
    params.validate();
    const items = await this.#channelStore.listChannels({
      ownerAccountId: this.ownerAccountId,
      groupId: params.groupId,
      includeDeleted: params.includeDeleted === true,
    });
    return new ChannelsListResult({ groupId: params.groupId, items });
  }

  async createChannel(payload = {}) {
    const params = this._coerceParams(payload, ChannelsCreateParams);
    params.validate();
    // Caller can send `label` (free-form, server slugifies), `channelId`
    // (pre-slugged, treated as both id and label), or both. We always
    // produce a clean channelId via slugify and keep the original label
    // text for display.
    const labelInput = params.label.length > 0 ? params.label : params.channelId;
    const explicitCid = params.channelId.trim();
    const cid = explicitCid && isValidChannelId(explicitCid)
      ? explicitCid
      : slugifyChannelLabel(labelInput);
    if (!cid || !isValidChannelId(cid)) {
      throw new Error("channels.create: label '" + labelInput + "' has no characters that slugify to [a-z0-9_-]{1,64}");
    }
    await this.bus.services.groups.requireSelfAdmin(params.groupId, "channels.create");
    const { channel, created } = await this.#channelStore.ensureChannel({
      ownerAccountId: this.ownerAccountId,
      groupId: params.groupId,
      channelId: cid,
      label: labelInput,
    });
    if (created) {
      this._emit("channel.upserted", new ChannelUpsertedEvent({ channel }));
      const peers = await this.#listOtherActiveMembers(params.groupId);
      await this.#fanOutGroupOp({
        targets: peers,
        payload: new GroupOpPayloadV1({
          op: "channel.create",
          groupId: params.groupId,
          channelId: cid,
          label: labelInput,
          actedAtMs: this.#clock(),
          groupOpId: nowOpId(),
        }),
      });
    }
    return new ChannelsCreateResult({ channel, created });
  }

  async deleteChannel(payload = {}) {
    const params = this._coerceParams(payload, ChannelsDeleteParams);
    params.validate();
    if (!isValidChannelId(params.channelId)) {
      throw new Error("channels.delete: channelId must be a slug matching [a-z0-9_-]{1,64}");
    }
    await this.bus.services.groups.requireSelfAdmin(params.groupId, "channels.delete");
    const { tombstoned } = await this.#channelStore.tombstoneChannel({
      ownerAccountId: this.ownerAccountId,
      groupId: params.groupId,
      channelId: params.channelId,
    });
    if (tombstoned) {
      this._emit("channel.removed", new ChannelRemovedEvent({
        groupId: params.groupId,
        channelId: params.channelId,
      }));
      const peers = await this.#listOtherActiveMembers(params.groupId);
      await this.#fanOutGroupOp({
        targets: peers,
        payload: new GroupOpPayloadV1({
          op: "channel.delete",
          groupId: params.groupId,
          channelId: params.channelId,
          actedAtMs: this.#clock(),
          groupOpId: nowOpId(),
        }),
      });
    }
    return new ChannelsDeleteResult({
      groupId: params.groupId,
      channelId: params.channelId,
      deleted: tombstoned,
    });
  }

  /**
   * Apply an inbound `channel.create` or `channel.delete` op. Called from
   * ServerGroupsService.handleIncomingGroupOp after that service has
   * verified the sender is an active group member. `isAdmin` indicates
   * whether the sender is a group admin — required for channel.delete.
   */
  async applyIncomingOp(op, { senderAccountId, isAdmin = false } = {}) {
    if (!(op instanceof GroupOpPayloadV1)) return false;
    const sender = typeof senderAccountId === "string" ? senderAccountId.trim() : "";
    if (!sender) return false;
    if (!op.channelId || !isValidChannelId(op.channelId)) {
      this.logger.warn("[ServerChannelsService] ignoring channel-op with invalid channelId: " + op.channelId);
      return true;
    }
    if (op.op === "channel.create") {
      const { channel, created } = await this.#channelStore.ensureChannel({
        ownerAccountId: this.ownerAccountId,
        groupId: op.groupId,
        channelId: op.channelId,
        label: op.label,
      });
      // Emit on first create AND on label-fill updates so renderer mirrors
      // the freshly-known display name when a label-carrying op arrives
      // after a labelless observation.
      if (created || (channel && channel.label && op.label && channel.label === op.label)) {
        this._emit("channel.upserted", new ChannelUpsertedEvent({ channel }));
      }
      return true;
    }
    if (op.op === "channel.delete") {
      if (!isAdmin) {
        this.logger.warn("[ServerChannelsService] ignoring channel.delete from non-admin " + sender);
        return true;
      }
      const { tombstoned } = await this.#channelStore.tombstoneChannel({
        ownerAccountId: this.ownerAccountId,
        groupId: op.groupId,
        channelId: op.channelId,
        deletedAtMs: op.actedAtMs,
      });
      if (tombstoned) {
        this._emit("channel.removed", new ChannelRemovedEvent({
          groupId: op.groupId,
          channelId: op.channelId,
        }));
      }
      return true;
    }
    return false;
  }

  /**
   * Catch-up: when a peer-link establishes for a group, the side that
   * already knows the group's channels re-sends every active (non-
   * tombstoned) channel as a `channel.create` op to the joining peer.
   * This closes the race where a channel.create fan-out ran before the
   * peer's active membership was registered locally and so missed them.
   *
   * Idempotent on the receiver: `ChannelStore.ensureChannel` is a no-op
   * if the channel already exists.
   */
  async fanoutChannelsToPeer({ groupId, peerAccountId } = {}) {
    const gid = typeof groupId === "string" ? groupId.trim() : "";
    const peer = typeof peerAccountId === "string" ? peerAccountId.trim() : "";
    if (!gid || !peer || peer === this.ownerAccountId) return;
    const channels = await this.#channelStore.listChannels({
      ownerAccountId: this.ownerAccountId,
      groupId: gid,
      includeDeleted: false,
    }).catch(() => []);
    const list = Array.isArray(channels) ? channels : [];
    for (const channel of list) {
      if (!channel || !channel.channelId) continue;
      await this.#fanOutGroupOp({
        targets: [peer],
        payload: new GroupOpPayloadV1({
          op: "channel.create",
          groupId: gid,
          channelId: channel.channelId,
          label: channel.label || "",
          actedAtMs: this.#clock(),
          groupOpId: nowOpId(),
        }),
      });
    }
  }

  /**
   * Materialize a channel record observed via an inbound message's
   * payload.channelId tag. Idempotent; emits channel.upserted only on
   * first observation. Silently ignores invalid/empty channelIds.
   *
   * When the observation creates a NEW channel and we know the message
   * sender, also enqueue a `channels.sync_request` back to them — the
   * fact that we're observing a previously-unknown channel means we
   * likely missed earlier channel.create ops too, so we ask for a full
   * replay.
   */
  async ensureFromObservedMessage({ groupId, channelId, senderAccountId = null } = {}) {
    if (!groupId || typeof groupId !== "string") return;
    if (!isValidChannelId(channelId)) return;
    const { channel, created } = await this.#channelStore.ensureChannel({
      ownerAccountId: this.ownerAccountId,
      groupId,
      channelId,
    }).catch((err) => {
      this.logger.warn("[ServerChannelsService] observation upsert failed", err && err.message ? err.message : err);
      return { channel: null, created: false };
    });
    if (created && channel) {
      this._emit("channel.upserted", new ChannelUpsertedEvent({ channel }));
      const sender = typeof senderAccountId === "string" ? senderAccountId.trim() : "";
      if (sender && sender !== this.ownerAccountId) {
        await this.#sendSyncRequest({ groupId, peerAccountId: sender }).catch((err) => {
          this.logger.warn("[ServerChannelsService] sync request to " + sender + " failed",
            err && err.message ? err.message : err);
        });
      }
    }
  }

  async #sendSyncRequest({ groupId, peerAccountId } = {}) {
    await this.#fanOutGroupOp({
      targets: [peerAccountId],
      payload: new GroupOpPayloadV1({
        op: "channels.sync_request",
        groupId,
        actedAtMs: this.#clock(),
        groupOpId: nowOpId(),
      }),
    });
  }

  async #listOtherActiveMembers(groupId) {
    const members = await this.#groupStore.listMembers({
      ownerAccountId: this.ownerAccountId,
      groupId,
    }).catch(() => []);
    const list = Array.isArray(members) ? members : [];
    const out = [];
    for (const m of list) {
      const id = String(m && m.accountId || "").trim();
      const state = String(m && m.state || "active").toLowerCase();
      if (!id || id === this.ownerAccountId || state !== "active") continue;
      out.push(id);
    }
    return out;
  }

  async #fanOutGroupOp({ targets, payload } = {}) {
    if (!Array.isArray(targets) || targets.length === 0) return;
    const sdk = this.bus.runtime ? this.bus.runtime.sdk : null;
    if (!sdk || typeof sdk.sealForPeer !== "function" || !sdk.mesh) {
      this.logger.warn("[ServerChannelsService] sdk unavailable, skipping channel-op fan-out");
      return;
    }
    const bodyBytes = groupOpPayloadToBytes(payload);
    await Promise.allSettled(targets.map((accountId) =>
      sdk.sealForPeer({
        peerAccountId: accountId,
        plaintextBodyBytes: bodyBytes,
      }).then((sealed) => sdk.mesh.dispatch(
        sealed.object,
        sealed.address,
      )).catch((err) => {
        this.logger.warn(
          "[ServerChannelsService] channel-op fan-out to " + accountId + " failed",
          err && err.message ? err.message : err,
        );
      })
    ));
  }
}
