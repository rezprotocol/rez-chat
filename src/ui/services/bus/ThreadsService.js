import { BaseBusService } from "./BaseBusService.js";
import { ChatThread, nonEmptyString } from "../../../records/index.js";

function isVisibleThread(thread) {
  const state = String(thread && thread.visibilityState || "visible").trim().toLowerCase();
  return state !== "hidden";
}

export class ThreadsService extends BaseBusService {
  constructor({ bus, threadStore, messageStore, uiStateStore } = {}) {
    super({ bus });
    if (!threadStore || !messageStore || !uiStateStore) {
      throw new Error("ThreadsService requires threadStore, messageStore, uiStateStore");
    }
    this._threadStore = threadStore;
    this._messageStore = messageStore;
    this._uiStateStore = uiStateStore;
    this._register("threads", "ensureList", (payload) => this.ensureList(payload));
    this._register("threads", "getIds", () => this.getIds());
    this._register("threads", "get", (payload) => this.get(payload));
    this._register("threads", "select", (payload) => this.select(payload));
    this._register("threads", "deselect", () => this.deselect());
    this._register("threads", "markRead", (payload) => this.markRead(payload));
    this._register("threads", "markChannelRead", (payload) => this.markChannelRead(payload));
    this._register("threads", "setState", (payload) => this.setState(payload));
    this._register("threads", "archive", (payload) => this.archive(payload));
    this._register("threads", "delete", (payload) => this.deleteThread(payload));
    this._register("threads", "createDirect", (payload) => this.createDirect(payload));
    this._listen("runtime.event.thread.index.updated", (record) => this._handleThreadIndexUpdated(record));
    const off = uiStateStore.onChange((evt) => {
      const type = evt && typeof evt.type === "string" ? evt.type : "";
      if (type === "ui.threadListFilter.changed") {
        this.bus.emit("threads.updated", {});
      }
    });
    this._offs.push(off);
    this._listen("runtime.event.peer-link.updated", () => {
      this.ensureList({ force: true }).catch((err) => {
        console.error("[ThreadsService] peer-link list refresh failed", err);
        this.bus.emit("app.error", { source: "ThreadsService", message: "peer-link list refresh failed", severity: "warn", err });
      });
    });
  }

  _getClient() {
    return this.bus.runtime && this.bus.runtime.client ? this.bus.runtime.client : null;
  }

  async ensureList({ limit = 100, force = false } = {}) {
    const client = this._getClient();
    if (!client) return this._threadStore.getThreads();
    if (!force && this._threadStore.isLoaded()) {
      return this._threadStore.getThreads();
    }
    const result = await client.call("threads.list", { limit });
    const threads = result && Array.isArray(result.threads) ? result.threads : [];
    this._threadStore.replaceThreads(threads);
    this.bus.emit("threads.updated", {});
    return this._threadStore.getThreads();
  }

  getIds() {
    const snap = this._uiStateStore.snapshot();
    const filters = Array.isArray(snap.threadListFilters) ? snap.threadListFilters : [];
    const isAll = filters.includes("all");
    return this._threadStore.getThreads()
      .filter((thread) => {
        if (isAll) return true;
        const visible = isVisibleThread(thread);
        let matches = false;
        if (filters.includes("dms") && thread.threadType === "direct") matches = true;
        if (filters.includes("groups") && thread.threadType === "group") matches = true;
        if (filters.includes("locked")) {
          const access = String(thread.accessState || "open").trim().toLowerCase();
          if (access === "locked") matches = true;
        }
        if (filters.includes("archived") && !visible) matches = true;
        if (!visible && !matches) return false;
        return matches;
      })
      .map((thread) => thread.threadId);
  }

  get({ threadId } = {}) {
    return this._threadStore.getThread(threadId);
  }

  getSelectedId() {
    return this._uiStateStore.snapshot().selectedThreadId;
  }

  deselect() {
    this._uiStateStore.setSelectedThreadId(null);
    return { selectedThreadId: null };
  }

  async select({ threadId, channelId = null } = {}) {
    const id = nonEmptyString(threadId);
    if (!id) return null;
    this._uiStateStore.setSelectedThreadId(id);
    // Channel scope precedence: explicit param → the thread's currently
    // active channel from uiState → implicit "#general" (""). Mark only
    // that channel read so badges on sibling channels of the same group
    // survive the open.
    const explicit = channelId == null ? null : String(channelId).trim();
    const active = explicit != null ? explicit : this.#activeChannelIdForThread(id);
    this.markChannelRead({ threadId: id, channelId: active }).catch((err) => {
      console.error("[ThreadsService] mark-channel-read failed", err);
      this.bus.emit("app.error", { source: "ThreadsService", message: "mark-channel-read failed", severity: "info", err });
    });
    return this._threadStore.getThread(id);
  }

  #activeChannelIdForThread(threadId) {
    if (!this._uiStateStore || typeof this._uiStateStore.getSelectedChannelId !== "function") return "";
    const id = nonEmptyString(threadId);
    if (!id) return "";
    return this._uiStateStore.getSelectedChannelId(id) || "";
  }

  async markRead({ threadId } = {}) {
    const id = nonEmptyString(threadId || this.getSelectedId());
    const client = this._getClient();
    if (!id || !client) return null;
    await client.call("thread.read", { threadId: id }).catch(() => null);
    this._threadStore.patchThread(id, { unreadCount: 0, unreadByChannelId: {} });
    this.bus.emit("threads.updated", { threadId: id });
    return this._threadStore.getThread(id);
  }

  async markChannelRead({ threadId, channelId = "" } = {}) {
    const id = nonEmptyString(threadId || this.getSelectedId());
    const client = this._getClient();
    if (!id || !client) return null;
    const ch = typeof channelId === "string" ? channelId.trim() : "";
    await client.call("thread.channel.read", { threadId: id, channelId: ch }).catch(() => null);
    // Optimistic local patch: drop just this channel's bucket; thread total
    // recomputes as the server's index-update event arrives.
    const current = this._threadStore.getThread(id);
    if (current) {
      const nextByChannel = { ...(current.unreadByChannelId || {}) };
      const droppedForChannel = Number(nextByChannel[ch] || 0);
      delete nextByChannel[ch];
      const nextUnreadCount = Math.max(0, Number(current.unreadCount || 0) - droppedForChannel);
      this._threadStore.patchThread(id, {
        unreadByChannelId: nextByChannel,
        unreadCount: nextUnreadCount,
      });
      this.bus.emit("threads.updated", { threadId: id });
    }
    return this._threadStore.getThread(id);
  }

  async setState({ threadId, visibilityState, accessState } = {}) {
    const id = nonEmptyString(threadId);
    const client = this._getClient();
    if (!id || !client) return null;
    const result = await client.call("thread.state.set", { threadId: id, visibilityState, accessState });
    const thread = result && result.thread ? result.thread : null;
    if (thread) {
      this._threadStore.upsertThread(thread);
      this.bus.emit("threads.updated", { threadId: id });
      return this._threadStore.getThread(id);
    }
    return null;
  }

  async archive({ threadId } = {}) {
    const id = nonEmptyString(threadId);
    if (!id) return null;
    const selectedId = this.getSelectedId();
    if (selectedId === id) {
      this._uiStateStore.setSelectedThreadId(null);
    }
    return this.setState({ threadId: id, visibilityState: "hidden" });
  }

  async deleteThread({ threadId } = {}) {
    const id = nonEmptyString(threadId);
    const client = this._getClient();
    if (!id || !client) return null;
    const selectedId = this.getSelectedId();
    if (selectedId === id) {
      this._uiStateStore.setSelectedThreadId(null);
    }
    const result = await client.call("thread.delete", { threadId: id });
    if (result && result.deleted) {
      this._threadStore.removeThread(id);
      this._messageStore.forgetThread(id);
      this.bus.emit("threads.updated", { threadId: id });
    }
    return result;
  }

  async createDirect({ accountId } = {}) {
    const id = nonEmptyString(accountId);
    const client = this._getClient();
    if (!id || !client) return null;
    const result = await client.call("thread.createDirect", { accountId: id });
    const thread = result && result.thread ? result.thread : null;
    if (thread) {
      this._threadStore.upsertThread(thread);
      this.bus.emit("threads.updated", {});
    }
    const threadId = thread && typeof thread.threadId === "string" ? thread.threadId.trim() : "";
    if (threadId) {
      this._uiStateStore.setSelectedThreadId(threadId);
    }
    return thread;
  }

  _handleThreadIndexUpdated(record) {
    const id = nonEmptyString(record && record.threadId);
    if (!id) return;
    const current = this._threadStore.getThread(id);
    if (!current) {
      this.ensureList({ force: true }).catch((err) => {
        console.error("[ThreadsService] index-update list refresh failed", err);
        this.bus.emit("app.error", { source: "ThreadsService", message: "index-update list refresh failed", severity: "warn", err });
      });
      return;
    }
    const incomingUnread = record && record.unreadCount != null ? record.unreadCount : current.unreadCount;
    const incomingByChannel = record && record.unreadByChannelId && typeof record.unreadByChannelId === "object"
      ? record.unreadByChannelId
      : current.unreadByChannelId;
    const selectedId = this.getSelectedId();
    const isSelected = selectedId === id;
    const activeChannelId = isSelected ? this.#activeChannelIdForThread(id) : "";
    // When the thread is selected, the active channel is being viewed so its
    // badge clears locally; other channels' badges remain.
    let displayByChannel = incomingByChannel;
    let displayUnread = incomingUnread;
    if (isSelected) {
      const next = { ...(incomingByChannel || {}) };
      const dropped = Number(next[activeChannelId] || 0);
      delete next[activeChannelId];
      displayByChannel = next;
      displayUnread = Math.max(0, Number(incomingUnread || 0) - dropped);
    }
    this._threadStore.upsertThread(new ChatThread({
      ...current.toJSON(),
      lastActivityAtMs: record && record.lastActivityAtMs != null ? record.lastActivityAtMs : current.lastActivityAtMs,
      lastMessagePreview: record && record.preview != null ? record.preview : current.lastMessagePreview,
      unreadCount: displayUnread,
      unreadByChannelId: displayByChannel,
    }));
    this.bus.emit("threads.updated", { threadId: id });
    if (isSelected && Number(incomingByChannel && incomingByChannel[activeChannelId] || 0) > 0) {
      this.markChannelRead({ threadId: id, channelId: activeChannelId }).catch((err) => {
        console.error("[ThreadsService] auto mark-channel-read failed", err);
        this.bus.emit("app.error", { source: "ThreadsService", message: "auto mark-channel-read failed", severity: "info", err });
      });
    }
  }
}
