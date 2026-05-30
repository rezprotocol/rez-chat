import { nonEmptyString } from "../../records/index.js";

export class UiStateStore {
  constructor({ bus } = {}) {
    this._bus = bus || null;
    this._state = {
      selectedThreadId: null,
      selectedContactGroupId: null,
      activeTab: "chat",
      focused: true,
      visible: true,
      authScreen: "unlock",
      threadListFilters: ["all"],
      // selectedChannelByThreadId: per-thread channel selection. Keys are
      // threadIds; values are non-empty channel slug or "" for #general.
      // Held inline in state (not a Map) so snapshot()/reset() stay shallow.
      selectedChannelByThreadId: {},
    };
    this._handlers = new Set();
  }

  onChange(handler) {
    if (typeof handler !== "function") return () => {};
    this._handlers.add(handler);
    return () => {
      this._handlers.delete(handler);
    };
  }

  _emit(type, keys = {}) {
    const evt = { store: "ui-state", type, keys };
    for (const handler of [...this._handlers]) {
      try {
        handler(evt);
      } catch (err) {
        console.error("[UiStateStore] handler threw", err);
        if (this._bus) this._bus.emit("app.error", { source: "UiStateStore", message: "handler threw", severity: "error", err });
      }
    }
  }

  snapshot() {
    return { ...this._state };
  }

  // ---- Typed accessors (own-data) ---------------------------------------

  activeTab() {
    const v = String(this._state.activeTab || "chat").trim().toLowerCase();
    if (v === "contacts" || v === "settings" || v === "profile") return v;
    return "chat";
  }

  authScreen() {
    const v = String(this._state.authScreen || "unlock").trim().toLowerCase();
    return v === "create" ? "create" : "unlock";
  }

  selectedThreadId() {
    const v = this._state.selectedThreadId;
    return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
  }

  selectedContactGroupId() {
    const v = this._state.selectedContactGroupId;
    return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
  }

  threadListFilters() {
    const list = Array.isArray(this._state.threadListFilters) ? this._state.threadListFilters : ["all"];
    return list.slice();
  }

  reset() {
    this._state = {
      selectedThreadId: null,
      selectedContactGroupId: null,
      activeTab: "chat",
      focused: true,
      visible: true,
      authScreen: "unlock",
      threadListFilters: ["all"],
      selectedChannelByThreadId: {},
    };
    this._emit("ui.reset");
  }

  setSelectedThreadId(threadId) {
    this._state.selectedThreadId = nonEmptyString(threadId) || null;
    this._emit("ui.selectedThread.changed", { threadId: this._state.selectedThreadId });
  }

  setSelectedContactGroupId(groupId) {
    this._state.selectedContactGroupId = nonEmptyString(groupId) || null;
    this._emit("ui.selectedContactGroup.changed", { groupId: this._state.selectedContactGroupId });
  }

  setActiveTab(tab) {
    const next = nonEmptyString(tab).toLowerCase();
    if (next === "chat" || next === "contacts" || next === "settings" || next === "profile") {
      this._state.activeTab = next;
      this._emit("ui.activeTab.changed", { tab: next });
    }
  }

  setVisibility({ focused, visible } = {}) {
    if (focused !== undefined) this._state.focused = focused === true;
    if (visible !== undefined) this._state.visible = visible === true;
    this._emit("ui.visibility.changed");
  }

  setThreadListFilters(filters) {
    const valid = ["all", "dms", "groups", "locked", "archived"];
    if (!Array.isArray(filters)) return;
    const next = filters.filter((f) => valid.includes(f));
    if (next.length === 0) return;
    this._state.threadListFilters = next.slice();
    this._emit("ui.threadListFilter.changed", { threadListFilters: next });
  }

  setSelectedChannelId(threadId, channelId) {
    const tid = nonEmptyString(threadId);
    if (!tid) return;
    const next = { ...(this._state.selectedChannelByThreadId || {}) };
    const cid = typeof channelId === "string" ? channelId.trim() : "";
    if (cid) next[tid] = cid;
    else delete next[tid];
    this._state.selectedChannelByThreadId = next;
    this._emit("ui.selectedChannel.changed", { threadId: tid, channelId: cid });
  }

  getSelectedChannelId(threadId) {
    const tid = nonEmptyString(threadId);
    if (!tid) return "";
    const map = this._state.selectedChannelByThreadId || {};
    return typeof map[tid] === "string" ? map[tid] : "";
  }

  setAuthScreen(screen) {
    const next = nonEmptyString(screen).toLowerCase();
    if (next !== "unlock" && next !== "create") {
      return;
    }
    this._state.authScreen = next;
    this._emit("ui.authScreen.changed", { authScreen: next });
  }
}
