import { Hash } from "@rezprotocol/sdk/hash";
import { IMAGE_KIND } from "../../records/payloads/index.js";
import { nonEmptyString } from "../../records/domain/coerce.js";
import {
  ChatThread,
  ThreadIndexUpdatedEvent,
  ThreadGetResult,
  ThreadGetParams,
  ThreadReadParams,
  ThreadReadResult,
  ThreadChannelReadParams,
  ThreadChannelReadResult,
  ThreadStateSetParams,
  ThreadStateSetResult,
  ThreadDeleteParams,
  ThreadDeleteResult,
  ThreadsListParams,
  ThreadsListResult,
  ThreadCreateDirectParams,
  GroupUpdatedEvent,
  GroupMembersUpdatedEvent,
} from "../../records/index.js";
import { THREAD_TYPES } from "../storage/ChatThreadStore.js";
import { BaseServerService } from "../base/BaseServerService.js";

const PEER_LINK_PREVIEW_PREFIX = "[peer-link] ";

export class ServerThreadsService extends BaseServerService {
  #threadStore;
  #threadIndex;
  #contactStore;
  #groupStore;
  #clock;

  constructor({
    bus,
    threadStore,
    threadIndex,
    contactStore,
    groupStore,
    ownerAccountId,
    clock = () => Date.now(),
    logger = console,
  } = {}) {
    super({ bus, ownerAccountId, logger });
    if (!threadStore || !threadIndex || !contactStore || !groupStore) {
      throw new Error("ServerThreadsService requires thread/contact/group stores");
    }
    this.#threadStore = threadStore;
    this.#threadIndex = threadIndex;
    this.#contactStore = contactStore;
    this.#groupStore = groupStore;
    this.#clock = clock;
    this._register("threads", "list", (payload) => this.listThreads(payload));
    this._register("thread", "get", (payload) => this.getThread(payload));
    this._register("thread", "read", (payload) => this.markThreadRead(payload));
    this._register("thread.channel", "read", (payload) => this.markChannelRead(payload));
    this._register("thread.state", "set", (payload) => this.setThreadState(payload));
    this._register("thread", "delete", (payload) => this.deleteThread(payload));
    this._register("thread", "createDirect", (payload) => this.createDirectThread(payload));
  }

  groupThreadId(groupId) {
    const digest = Hash.sha256(new TextEncoder().encode("group:v1|" + String(groupId || "")));
    const b64 = Buffer.from(digest.subarray(0, 16)).toString("base64")
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
    return "th_" + b64;
  }

  directThreadIdForPeerLink(peerLinkId, peerAccountId = "") {
    const id = String(peerLinkId || "").trim();
    if (!id) return "";
    const remote = String(peerAccountId || "").trim();
    const digest = Hash.sha256(new TextEncoder().encode("direct:v1|" + id + "|" + remote));
    const b64 = Buffer.from(digest.subarray(0, 16)).toString("base64")
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
    return "th_" + b64;
  }

  extractPreviewText(data) {
    if (!data || typeof data !== "object") return "";
    if (typeof data.kind === "string" && data.kind === IMAGE_KIND) {
      const caption = typeof data.text === "string" ? data.text.trim() : "";
      return caption || "Photo";
    }
    if (typeof data.text === "string" && data.text.trim().length > 0) {
      return data.text.trim();
    }
    const payload = data.payload && typeof data.payload === "object" ? data.payload : null;
    if (payload && typeof payload.kind === "string" && payload.kind === IMAGE_KIND) {
      const caption = typeof payload.text === "string" ? payload.text.trim() : "";
      return caption || "Photo";
    }
    if (payload && typeof payload.text === "string") {
      return payload.text.trim();
    }
    return "";
  }

  parsePeerLinkPreview(value) {
    const text = String(value || "");
    if (!text.startsWith(PEER_LINK_PREVIEW_PREFIX)) {
      return null;
    }
    const payload = text.slice(PEER_LINK_PREVIEW_PREFIX.length);
    const parts = payload.split("|");
    const tone = String(parts[0] || "warn").trim().toLowerCase();
    const label = String(parts[1] || "PENDING").trim().toUpperCase() || "PENDING";
    const detail = String(parts.slice(2).join("|") || "").trim();
    return {
      tone: tone === "ok" || tone === "error" ? tone : "warn",
      label,
      text: detail,
    };
  }

  decorateThreadView(thread) {
    const row = thread && typeof thread === "object" ? thread : null;
    if (!row) return null;
    // row is already a ChatThread (records at every boundary). It carries
    // canonical threadType, accessState, threadReady, and sendAllowed —
    // computed by the record constructor from peerInboxId/peerAccountId.
    // The presenter only adds derived view fields (securityState, peerLinkState,
    // displayTitle) that the storage layer can't know.
    const { threadType, accessState, threadReady } = row;
    const peerLinkPreview = this.parsePeerLinkPreview(row.lastMessagePreview);
    const securityState = nonEmptyString(row.securityState) === ""
      ? (
          peerLinkPreview && peerLinkPreview.tone === "ok"
            ? "secure"
            : peerLinkPreview
              ? "pending"
              : threadType === "group"
                ? "secure"
                : threadReady
                  ? "secure"
                  : "pending"
        )
      : row.securityState;
    const peerLinkState = nonEmptyString(row.peerLinkState) === ""
      ? (peerLinkPreview && peerLinkPreview.label
          ? String(peerLinkPreview.label).trim().toLowerCase()
          : threadReady
            ? "established"
            : "pending")
      : row.peerLinkState;
    const explicitTitle = nonEmptyString(row.title);
    const displayTitle = nonEmptyString(row.displayTitle)
      || explicitTitle
      || (threadType === "direct" && !threadReady ? "Pending conversation" : row.threadId);
    return new ChatThread({
      ...row.toJSON(),
      securityState,
      peerLinkState,
      displayTitle,
    });
  }

  emitThreadIndexUpdated(indexRecord) {
    const row = indexRecord && typeof indexRecord === "object" ? indexRecord : null;
    const threadId = row && typeof row.threadId === "string" ? row.threadId.trim() : "";
    if (!threadId) return null;
    const record = new ThreadIndexUpdatedEvent({
      threadId,
      lastActivityAtMs: row.lastActivityAtMs,
      preview: row.lastMessagePreview,
      unreadCount: row.unreadCount,
      unreadByChannelId: row.unreadByChannelId && typeof row.unreadByChannelId === "object"
        ? row.unreadByChannelId : {},
    });
    this._emit("runtime.event.thread.index.updated", record);
    this._emit("thread.index.updated", record);
    return record;
  }

  async #loadThreadSummary(threadId, providedThread = null, providedIndex = null) {
    const id = typeof threadId === "string" ? threadId.trim() : "";
    if (!id) return null;
    const storedThread = providedThread || await this.#threadStore.getThread(id).catch(() => null);
    let indexRecord = providedIndex || await this.#threadIndex.getIndexRecord({ threadId: id }).catch(() => null);
    const needsIndexRepair = !!(
      storedThread
      && (
        !indexRecord
        || !indexRecord.lastActivityMsgId
        || (indexRecord.lastMessagePreview == null && indexRecord.lastActivityAtMs > 0)
      )
    );
    if (needsIndexRepair) {
      indexRecord = await this.#threadIndex.ensureThreadSummary({ threadId: id }).catch(() => indexRecord);
    }
    if (storedThread && indexRecord) {
      // Merge: storedThread (ChatThread) provides identity + peer-link
      // shape; indexRecord (ChatThreadIndexEntry) provides the activity
      // summary. Pull ONLY the index-summary fields onto the thread row;
      // a blind spread would also drag in ChatThreadIndexEntry's read-
      // cursor fields (lastReadAtMs etc.) that ChatThread silently drops.
      return this.decorateThreadView(new ChatThread({
        ...storedThread.toJSON(),
        lastActivityAtMs: indexRecord.lastActivityAtMs,
        lastActivityMsgId: indexRecord.lastActivityMsgId,
        lastMessagePreview: indexRecord.lastMessagePreview,
        unreadCount: indexRecord.unreadCount,
        unreadByChannelId: indexRecord.unreadByChannelId,
        updatedAtMs: indexRecord.updatedAtMs,
      }));
    }
    if (storedThread) {
      return this.decorateThreadView(storedThread);
    }
    if (indexRecord) {
      // Orphaned index entry (storage row missing). Construct a minimal
      // ChatThread with just the summary fields; threadType defaults to
      // "direct" because we have no peer-link state to infer from.
      return this.decorateThreadView(new ChatThread({
        threadId: indexRecord.threadId,
        threadType: "direct",
        lastActivityAtMs: indexRecord.lastActivityAtMs,
        lastActivityMsgId: indexRecord.lastActivityMsgId,
        lastMessagePreview: indexRecord.lastMessagePreview,
        unreadCount: indexRecord.unreadCount,
        unreadByChannelId: indexRecord.unreadByChannelId,
        updatedAtMs: indexRecord.updatedAtMs,
      }));
    }
    return null;
  }

  async ensureDirectThread({ threadId, peerAccountId = null, peerInboxId = null, createdAtMs = null } = {}) {
    const id = typeof threadId === "string" ? threadId.trim() : "";
    if (!id) return null;
    await this.#threadStore.ensureThread({
      threadId: id,
      threadType: THREAD_TYPES.DIRECT,
      peerAccountId: peerAccountId || null,
      peerInboxId: peerInboxId || null,
      createdAtMs: createdAtMs == null ? this.#clock() : createdAtMs,
    });
    return this.getThread({ threadId: id });
  }

  async ensureGroupThread({ groupId, title = null, peerAccountId = null, createdAtMs = null } = {}) {
    const id = typeof groupId === "string" ? groupId.trim() : "";
    if (!id) return null;
    const threadId = this.groupThreadId(id);
    await this.#groupStore.ensureGroup({
      ownerAccountId: this.ownerAccountId,
      groupId: id,
      createdBy: peerAccountId || this.ownerAccountId,
      title,
    });
    await this.#groupStore.ensureMembership({
      ownerAccountId: this.ownerAccountId,
      groupId: id,
      accountId: this.ownerAccountId,
      role: "member",
    });
    if (peerAccountId) {
      await this.#groupStore.ensureMembership({
        ownerAccountId: this.ownerAccountId,
        groupId: id,
        accountId: peerAccountId,
        role: "member",
      });
    }
    await this.#threadStore.ensureThread({
      threadId,
      groupId: id,
      threadType: "group",
      title,
      createdAtMs: createdAtMs == null ? this.#clock() : createdAtMs,
    });
    await this.#emitGroupUpdated(id);
    await this.#emitGroupMembersUpdated(id);
    return this.getThread({ threadId });
  }

  async #emitGroupUpdated(groupId) {
    if (!groupId) return;
    const groups = await this.#groupStore.listGroups({ ownerAccountId: this.ownerAccountId }).catch(() => []);
    const list = Array.isArray(groups) ? groups : [];
    const group = list.find((g) => g && g.groupId === groupId) || null;
    if (group) this._emit("group.updated", new GroupUpdatedEvent({ group }));
  }

  async #emitGroupMembersUpdated(groupId) {
    if (!groupId) return;
    const items = await this.#groupStore.listMembers({
      ownerAccountId: this.ownerAccountId,
      groupId,
    }).catch(() => []);
    const list = Array.isArray(items) ? items : [];
    const groupsService = this.bus.services && this.bus.services.groups;
    const stamped = groupsService && typeof groupsService.stampFounderAsAdmin === "function"
      ? await groupsService.stampFounderAsAdmin(groupId, list)
      : list;
    this._emit("group.members.updated", new GroupMembersUpdatedEvent({
      groupId,
      members: stamped,
    }));
  }

  async createDirectThread(payload = {}) {
    const params = this._coerceParams(payload, ThreadCreateDirectParams);
    const peerLinksResult = await this._call("peer-links", "list", {});
    const items = peerLinksResult && Array.isArray(peerLinksResult.items) ? peerLinksResult.items : [];
    const peerLink = items.find((pl) => {
      const remoteId = pl && typeof pl.peerAccountId === "string" ? pl.peerAccountId.trim() : "";
      return remoteId === params.accountId;
    });
    if (!peerLink) {
      throw new Error("No peer link found for contact " + params.accountId);
    }
    const threadId = this.directThreadIdForPeerLink(peerLink.peerLinkId, params.accountId);
    if (!threadId) {
      throw new Error("Peer link has no stable id for contact " + params.accountId);
    }
    const peerInboxId = typeof peerLink.peerInboxId === "string" ? peerLink.peerInboxId.trim() : null;
    const result = await this.ensureDirectThread({
      threadId,
      peerAccountId: params.accountId,
      peerInboxId: peerInboxId || null,
    });
    this.emitThreadIndexUpdated({
      threadId,
      lastActivityAtMs: this.#clock(),
      lastMessagePreview: null,
      unreadCount: 0,
    });
    return result;
  }

  async listThreads(payload = {}) {
    const params = this._coerceParams(payload, ThreadsListParams);
    const indexResult = await this.#threadIndex.listThreads({ limit: params.limit });
    const rows = indexResult && Array.isArray(indexResult.threads) ? indexResult.threads : [];
    const threads = [];
    for (const row of rows) {
      const threadId = row && typeof row.threadId === "string" ? row.threadId.trim() : "";
      if (!threadId) {
        threads.push(this.decorateThreadView(row));
        continue;
      }
      const merged = await this.#loadThreadSummary(threadId, null, row).catch(() => this.decorateThreadView(row));
      threads.push(merged);
    }
    return new ThreadsListResult({
      threads: threads.filter(Boolean),
      cursor: indexResult && typeof indexResult.cursor === "string" ? indexResult.cursor : null,
    });
  }

  async getThread(payload = {}) {
    const params = this._coerceParams(payload, ThreadGetParams);
    const thread = await this.#loadThreadSummary(params.threadId);
    const messages = await this._call("thread.messages", "list", {
      threadId: params.threadId,
      limit: params.limit,
    });
    return new ThreadGetResult({
      thread,
      messages: {
        messages: messages && Array.isArray(messages.items) ? messages.items : [],
        nextBefore: messages && messages.nextBefore ? messages.nextBefore : null,
      },
    });
  }

  async markThreadRead(payload = {}) {
    const params = this._coerceParams(payload, ThreadReadParams);
    const result = await this.#threadIndex.markThreadRead({ threadId: params.threadId });
    this.emitThreadIndexUpdated(result);
    return new ThreadReadResult({
      threadId: params.threadId,
      readAtMs: this.#clock(),
      indexRecord: result,
    });
  }

  async markChannelRead(payload = {}) {
    const params = this._coerceParams(payload, ThreadChannelReadParams);
    const result = await this.#threadIndex.markChannelRead({
      threadId: params.threadId,
      channelId: params.channelId,
    });
    this.emitThreadIndexUpdated(result);
    return new ThreadChannelReadResult({
      threadId: params.threadId,
      channelId: params.channelId,
      readAtMs: this.#clock(),
    });
  }

  async deleteThread(payload = {}) {
    const params = this._coerceParams(payload, ThreadDeleteParams);
    const deleted = await this.#threadStore.deleteThread(params.threadId);
    if (deleted) {
      await this.#threadIndex.removeThread({ threadId: params.threadId }).catch((err) => {
        this.logger.error("[ServerThreadsService] index removal failed during delete", err && err.message ? err.message : err);
      });
      this._emit("threads.updated", { threadId: params.threadId, deleted: true });
    }
    return new ThreadDeleteResult({
      threadId: params.threadId,
      deleted,
    });
  }

  async setThreadState(payload = {}) {
    const params = this._coerceParams(payload, ThreadStateSetParams);
    const thread = await this.#threadStore.setThreadState({
      threadId: params.threadId,
      visibilityState: params.visibilityState,
      accessState: params.accessState,
    });
    return new ThreadStateSetResult({
      thread: this.decorateThreadView(thread),
    });
  }
}
