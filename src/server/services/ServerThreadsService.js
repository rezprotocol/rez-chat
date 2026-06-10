import { Hash } from "@rezprotocol/sdk/hash";
import { IMAGE_KIND, SYSTEM_EVENT_KIND } from "../../records/payloads/index.js";
import { nonEmptyString } from "../../records/domain/coerce.js";
import {
  ChatThread,
  ThreadIndexUpdatedEvent,
  ThreadUpdatedEvent,
  ThreadRemovedEvent,
  MessageDepositedEvent,
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

  // Deterministically derive a groupId from its creator + a per-group salt.
  // This is the COMMITMENT that binds the founder to the groupId: only the real
  // (createdBy, creatorSalt) pair hashes to the real groupId, so an acceptor can
  // verify a claimed founder against the groupId itself and a malicious inviter
  // cannot substitute a different createdBy (audit pass 5, H2 closure). The
  // founder uses this to mint the groupId; acceptors use it to verify.
  groupIdForCreator(createdBy, creatorSalt) {
    return this.groupThreadId(String(createdBy || "") + ":" + String(creatorSalt || "")).replace(/^th_/, "grp_");
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

  /**
   * Every direct (1:1) threadId whose STORED record names this peer. The
   * threadId is derived from the peer-link id at creation time, but a peer's
   * link can drift — recovery-via-reinvite replaces the peerLinkId, and old
   * links fall out of the live peer-links list — so recomputing the id from
   * the CURRENT links misses threads keyed to a since-replaced link. The
   * stored record, by contrast, always carries the peerAccountId (every
   * ensureDirectThread call sets it), so scanning records is the drift-proof
   * way to find ALL of a peer's direct threads (used by the contact-delete
   * cascade to avoid stranding orphans). Scans only existing storage records;
   * orphaned index-only rows have no peerAccountId to match and are handled by
   * deleteThread directly.
   */
  async listDirectThreadIdsForPeer(peerAccountId) {
    const id = typeof peerAccountId === "string" ? peerAccountId.trim() : "";
    if (!id) return [];
    const threadIds = await this.#threadStore.listThreadIds().catch(() => []);
    const matches = [];
    for (const raw of Array.isArray(threadIds) ? threadIds : []) {
      const threadId = typeof raw === "string" ? raw.trim() : "";
      if (!threadId) continue;
      const record = await this.#threadStore.getThread(threadId).catch(() => null);
      if (!record || typeof record !== "object") continue;
      const type = String(record.threadType || "direct").trim().toLowerCase();
      const peer = typeof record.peerAccountId === "string" ? record.peerAccountId.trim() : "";
      if (type === THREAD_TYPES.DIRECT && peer === id) {
        matches.push(threadId);
      }
    }
    return matches;
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

  /**
   * Persist the locally-derived "connect.accepted" system row into a direct
   * thread (the 1:1 analog of #persistJoinSystemMessage for groups). SSOT for
   * this row's shape + side effects: BOTH sides call it — the approver from
   * approveConnectRequest, and the requester from handleIncomingConnectAccepted
   * once the acceptance trigger resolves their thread — so the row, index bump,
   * and live timeline append are identical on both ends.
   *
   * Idempotent by messageId (acceptor + actedAtMs), so a re-delivered trigger
   * or a re-approve collapses onto the same row. Emits message.deposited so an
   * open timeline appends it live, and bumps the thread index so it surfaces in
   * the conversation list.
   */
  async persistConnectAcceptedSystemMessage({ threadId, acceptorAccountId, acceptorDisplayName = "", actedAtMs = null } = {}) {
    const id = typeof threadId === "string" ? threadId.trim() : "";
    const actor = typeof acceptorAccountId === "string" ? acceptorAccountId.trim() : "";
    if (!id || !actor) return;
    const ts = Number.isFinite(actedAtMs) ? actedAtMs : this.#clock();
    const messageId = "sys:connaccept:" + actor + ":" + ts;
    const payload = {
      kind: SYSTEM_EVENT_KIND,
      event: "connect.accepted",
      actorAccountId: actor,
      actorDisplayName: typeof acceptorDisplayName === "string" ? acceptorDisplayName : "",
      actedAtMs: ts,
    };
    await this.#threadStore.upsertMessage({
      messageId,
      threadId: id,
      senderAccountId: null,
      senderKey: "system",
      payload,
      text: "",
      status: "delivered",
      createdAtMs: ts,
      acceptedAtMs: ts,
    }).catch((err) => {
      this.logger.warn("[ServerThreadsService] connect-accepted system message persist failed",
        err && err.message ? err.message : err);
    });
    const indexRecord = await this.#threadIndex.upsertFromMessage({
      threadId: id,
      messageId,
      ts,
      preview: null,
    }).catch((err) => {
      this.logger.warn("[ServerThreadsService] connect-accepted index upsert failed",
        err && err.message ? err.message : err);
      return null;
    });
    if (indexRecord) this.emitThreadIndexUpdated(indexRecord);
    const deposited = new MessageDepositedEvent({
      threadId: id,
      message: {
        messageId,
        threadId: id,
        senderAccountId: null,
        text: "",
        payload,
        status: "delivered",
        createdAtMs: ts,
        acceptedAtMs: ts,
      },
    });
    this._emit("runtime.event.message.deposited", deposited);
    this._emit("message.deposited", deposited);
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

  async ensureGroupThread({ groupId, title = null, peerAccountId = null, groupCreatedBy = null, creatorSalt = null, createdAtMs = null, joinedViaInviteId = null } = {}) {
    const id = typeof groupId === "string" ? groupId.trim() : "";
    if (!id) return null;
    const threadId = this.groupThreadId(id);
    await this.#groupStore.ensureGroup({
      ownerAccountId: this.ownerAccountId,
      groupId: id,
      // Prefer the TRUE founder carried in the signed invite envelope (already
      // VERIFIED against the groupId by acceptInvite); fall back to the inviter
      // only when unknown (e.g. legacy/self-created). The founder rule
      // (createdBy → effective admin/creator) must not be hijackable by whoever
      // happened to invite us (audit pass 5, H2).
      createdBy: (typeof groupCreatedBy === "string" && groupCreatedBy.trim())
        ? groupCreatedBy.trim()
        : (peerAccountId || this.ownerAccountId),
      // Store the verified salt so WE can relay it when inviting others.
      creatorSalt: typeof creatorSalt === "string" ? creatorSalt.trim() : null,
      title,
      joinedViaInviteId,
    });
    await this.#groupStore.ensureMembership({
      ownerAccountId: this.ownerAccountId,
      groupId: id,
      accountId: this.ownerAccountId,
      role: "member",
    });
    // Re-joining after a kick/leave: revive our own removed membership so our
    // local view reflects the rejoin. Authoritative re-admission on every OTHER
    // member's node is gated by the inviter's freshness-checked member.join;
    // this local revival is optimistic UI only, and is contained by the
    // receive-side membership gate (a not-yet-readmitted sender's group
    // messages are dropped by peers).
    await this.#groupStore.reviveMembership({
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
      // Rejoining must unlock a thread an earlier kick/leave set to "locked";
      // a first join is already "open" so this is a no-op there. Safe because
      // the receive-side membership gate (H1) drops content from senders the
      // group hasn't actually re-admitted.
      accessState: "open",
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
    const recordDeleted = await this.#threadStore.deleteThread(params.threadId);
    // Clear the conversation-list index row INDEPENDENTLY of the storage
    // record. A thread can be orphaned — index row present but storage record
    // already gone — e.g. an older partial teardown that removed the contact
    // but not the thread. Such a row renders as a bare threadId and was
    // previously undeletable: recordDeleted came back false, so we skipped
    // both the index removal and the UI event, and the row stuck forever.
    const indexRow = await this.#threadIndex.getIndexRecord({ threadId: params.threadId }).catch(() => null);
    const hadIndexRow = !!indexRow;
    if (hadIndexRow) {
      await this.#threadIndex.removeThread({ threadId: params.threadId }).catch((err) => {
        this.logger.error("[ServerThreadsService] index removal failed during delete", err && err.message ? err.message : err);
      });
    }
    const deleted = recordDeleted || hadIndexRow;
    if (deleted) {
      // Authoritative removal event: the single signal every client store/view
      // reacts to. Fires for BOTH the direct thread.delete RPC and the
      // server-initiated cascade (contact delete tears down its DM threads) —
      // the latter has no client RPC, so without this event the renderer never
      // learns the thread is gone and it strands as a bare-id row.
      this._emit("thread.removed", new ThreadRemovedEvent({ threadId: params.threadId }));
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
    const view = this.decorateThreadView(thread);
    // Archive/hide/lock is account-state, not just acting-device UI. Emit a
    // bridged thread.updated so every connected client of this account reacts —
    // today the acting renderer hand-patches, but a second device (multi-tenant
    // node / mobile) shares this store and must learn via the event.
    if (view) {
      this._emit("thread.updated", new ThreadUpdatedEvent({ thread: view }));
    }
    return new ThreadStateSetResult({ thread: view });
  }
}
