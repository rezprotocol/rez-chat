import { h } from "@rezprotocol/ui";
import { BusComponent } from "../base/BusComponent.js";
import { materialIcon } from "../base/icon.js";
import { ContactAvatarView } from "./ContactAvatarView.js";
import { ThreadChannelListView } from "./ThreadChannelListView.js";
import { shortId } from "../presenters/labels.js";

function formatTime(ms) {
  if (!ms || !Number.isFinite(ms)) return "";
  const date = new Date(ms);
  const now = new Date();
  const diffDays = Math.floor((now - date) / 86400000);
  if (diffDays === 0) return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (diffDays === 1) return "YESTERDAY";
  if (diffDays < 7) return ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"][date.getDay()];
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

function resolvePreview(thread) {
  const preview = thread.lastMessagePreview == null ? "" : String(thread.lastMessagePreview);
  if (!preview.trim()) return "No messages yet";
  return preview.length > 120 ? preview.slice(0, 120) : preview;
}

export class ThreadListItemView extends BusComponent {
  #avatarView;
  #channelListView;
  #expanded;
  #channelSlot;

  constructor({ bus, threadId } = {}) {
    super({ bus });
    this._threadId = String(threadId || "").trim();
    this.#avatarView = null;
    this.#channelListView = null;
    this.#expanded = false;
    this.#channelSlot = null;
  }

  get threadId() {
    return this._threadId;
  }

  mount(parentEl) {
    super.mount(parentEl);
    if (!this._rootEl) return;
    const stores = this.bus.stores || {};
    if (stores.threads) {
      this._subscribe(stores.threads, (evt) => {
        const type = evt && typeof evt.type === "string" ? evt.type : "";
        const keys = evt && evt.keys ? evt.keys : {};
        if (type === "threads.upserted" && keys.threadId !== this._threadId) return;
        if (type === "threads.removed" && keys.threadId !== this._threadId) return;
        this.render();
      });
    }
    if (stores.contacts) {
      this._subscribe(stores.contacts, () => this.render());
    }
    if (stores.groups) {
      this._subscribe(stores.groups, () => this.render());
    }
    if (stores.uiState) {
      this._subscribe(stores.uiState, (evt) => {
        const type = evt && typeof evt.type === "string" ? evt.type : "";
        if (type === "ui.selectedThread.changed") {
          // Auto-expand when this group thread becomes the selection so the
          // user sees the nested channels they just opened.
          const keys = evt && evt.keys ? evt.keys : {};
          if (this.#isGroupThread() && keys.threadId === this._threadId) {
            this.#expanded = true;
          }
          this.render();
        } else if (type === "ui.selectedChannel.changed") {
          const keys = evt && evt.keys ? evt.keys : {};
          if (keys.threadId === this._threadId) this.render();
        }
      });
    }
    if (stores.session) {
      this._subscribe(stores.session, (evt) => {
        const type = evt && typeof evt.type === "string" ? evt.type : "";
        if (type === "session.accountListChanged") this.render();
      });
    }
    this.render();
  }

  render() {
    if (!this._rootEl) return;
    const stores = this.bus.stores || {};
    const thread = stores.threads ? stores.threads.getThread(this._threadId) : null;
    if (!thread || !thread.threadId) {
      this.#teardownChannelList();
      this._rootEl.replaceChildren();
      return;
    }
    const selected = stores.uiState.selectedThreadId() === thread.threadId;
    const isGroup = !!(thread.groupId && String(thread.groupId).trim());
    // First-time auto-expand if this group thread is already the selection
    // when the row mounts (e.g. after a tab switch or page reload).
    if (isGroup && selected && !this.#expanded) this.#expanded = true;
    const title = this.bus.queries.threads.displayLabel(thread.threadId) || shortId(thread.threadId, 16);
    const preview = resolvePreview(thread);
    const time = formatTime(thread.lastActivityAtMs);
    const unreadCount = Math.max(0, Number(thread.unreadCount || 0));
    const unread = unreadCount > 0;
    const isLocked = String(thread.accessState || "open").trim().toLowerCase() === "locked";
    const isArchived = String(thread.visibilityState || "visible").trim().toLowerCase() === "hidden";
    const avatarHash = stores.contacts.getAvatarHash(thread.peerAccountId);

    const avatarSlot = h("div", { className: "w-12 h-12" });
    if (this.#avatarView) {
      this.#avatarView.unmount();
    }
    this.#avatarView = new ContactAvatarView({
      bus: this.bus,
      label: title || thread.threadId,
      fileHashHex: avatarHash,
      sizeClass: "w-12 h-12",
      roundedClass: "rounded-xl",
    });

    // When a group row is expanded, drop its bottom rounding so the
    // recessed channel section underneath reads as the same card's body.
    const isExpandedGroup = isGroup && this.#expanded;
    const cornerClass = isExpandedGroup ? " rounded-t-xl" : " rounded-xl";
    const baseRowClass = "tactile-card p-4 flex items-center gap-4 cursor-pointer relative group/thread w-full text-left" + cornerClass;
    const row = h("button", {
      type: "button",
      className: selected ? baseRowClass + " active-session" : baseRowClass,
      "data-testid": "thread.row",
      "data-thread-id": thread.threadId,
    }, [
      h("div", { className: "relative shrink-0" }, [
        avatarSlot,
        isLocked ? h("div", { className: "absolute -top-1 -right-1 w-4 h-4 bg-surface-container-lowest/90 rounded-full flex items-center justify-center" }, [
          h("span", { className: "material-symbols-outlined text-error", style: { fontSize: "10px" } }, "lock"),
        ]) : null,
        isArchived ? h("div", { className: "absolute -top-1 " + (isLocked ? "-left-1" : "-right-1") + " w-4 h-4 bg-surface-container-lowest/90 rounded-full flex items-center justify-center" }, [
          h("span", { className: "material-symbols-outlined text-outline", style: { fontSize: "10px" } }, "archive"),
        ]) : null,
      ]),
      h("div", { className: "flex-1 min-w-0" }, [
        h("div", { className: "flex justify-between items-start mb-0.5" }, [
          h("span", { className: "text-body-base font-bold text-on-surface truncate font-body-base" }, title),
          time ? h("span", {
            className: (unread ? "text-primary" : "text-on-surface-variant/40") + " text-label-micro font-label-technical shrink-0 ml-2",
          }, time) : null,
        ]),
        h("p", { className: "text-body-sm font-body-sm text-on-surface-variant/70 truncate" }, preview),
      ]),
      unread ? h("div", { className: "shrink-0 ml-1" }, [
        h("div", {
          className: "min-w-[1.25rem] h-5 px-1.5 rounded-full bg-primary text-on-primary text-label-micro font-label-technical font-bold leading-none flex items-center justify-center status-glow-cyan",
        }, String(unreadCount)),
      ]) : null,
      isGroup ? this.#buildExpandIndicator() : null,
    ]);
    row.addEventListener("click", (evt) => {
      if (isGroup) {
        // Group rows are folder headers: the row toggles furl/unfurl. Channel
        // selection happens on the nested rows. Never select the bare group.
        this.#expanded = !this.#expanded;
        this.render();
        return;
      }
      this.bus.call("threads", "select", { threadId: this._threadId }).catch((err) => {
        console.error("[ThreadListItemView] select thread failed", err);
        this.bus.emit("app.error", { source: "ThreadListItemView", message: "select thread failed", severity: "warn", err });
      });
    });

    // Reuse a persistent channel slot across renders so the child
    // ThreadChannelListView's _rootEl stays connected to the DOM. Recreating
    // it each render would orphan the mounted child (DOM detached, object
    // still alive) and a subsequent channel-click → ui.selectedThread.changed
    // re-render would silently break the unfurl.
    if (!this.#channelSlot) {
      this.#channelSlot = h("div", {}, []);
    }
    // Extend the active left-rail through the unfurled channel list when the
    // group itself is the current selection.
    this.#channelSlot.className = (selected && isExpandedGroup) ? "channel-list-active-trail" : "";
    this._rootEl.replaceChildren(row, this.#channelSlot);
    this.#avatarView.mount(avatarSlot);
    this.#syncChannelList({ isGroup, groupId: thread.groupId });
  }

  #buildExpandIndicator() {
    // Pure visual affordance — the entire row toggles furl/unfurl, so this
    // is not its own hit target.
    return h("span", {
      className: "shrink-0 ml-1 w-5 h-5 flex items-center justify-center text-on-surface-variant/60 pointer-events-none",
      "aria-hidden": "true",
      "data-testid": "thread.expand-indicator",
    }, [materialIcon(this.#expanded ? "expand_less" : "expand_more", { size: 18 })]);
  }

  #syncChannelList({ isGroup, groupId }) {
    if (!isGroup || !this.#expanded) {
      this.#teardownChannelList();
      return;
    }
    const gid = String(groupId || "").trim();
    if (!gid) {
      this.#teardownChannelList();
      return;
    }
    if (this.#channelListView) {
      // Already mounted — its own subscriptions handle internal updates.
      return;
    }
    if (!this.#channelSlot) return;
    this.#channelListView = new ThreadChannelListView({
      bus: this.bus,
      threadId: this._threadId,
      groupId: gid,
    });
    this.#channelListView.mount(this.#channelSlot);
  }

  #teardownChannelList() {
    if (this.#channelListView) {
      this.#channelListView.unmount();
      this.#channelListView = null;
    }
  }

  #isGroupThread() {
    const stores = this.bus.stores || {};
    const thread = stores.threads ? stores.threads.getThread(this._threadId) : null;
    return !!(thread && thread.groupId && String(thread.groupId).trim());
  }

  unmount() {
    this.#teardownChannelList();
    this.#channelSlot = null;
    if (this.#avatarView) {
      this.#avatarView.unmount();
      this.#avatarView = null;
    }
    super.unmount();
  }
}
