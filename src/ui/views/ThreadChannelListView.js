import { h } from "@rezprotocol/ui";
import { BusComponent } from "../base/BusComponent.js";
import { materialIcon } from "../base/icon.js";

const GENERAL_CHANNEL_ID = "";

const SECTION_CLASS = "channel-list-recessed py-3 space-y-1.5";
const HEADER_CLASS = "pl-12 pr-3 py-1 mb-1 flex items-center justify-between text-on-surface-variant/50 text-label-micro font-label-technical uppercase tracking-wider";
const ROW_BASE_CLASS = "pl-12 pr-4 py-1.5 flex items-center gap-2 cursor-pointer text-on-surface-variant/60 hover:text-primary hover:bg-primary/5 transition-all text-body-sm font-label-technical";
const ROW_ACTIVE_CLASS = "pl-12 pr-4 py-1.5 flex items-center gap-2 cursor-pointer text-primary bg-primary/10 text-body-sm font-label-technical";
const ADD_BTN_CLASS = "w-5 h-5 flex items-center justify-center rounded text-on-surface-variant/60 hover:text-primary hover:bg-primary/10 transition-colors";

/**
 * ThreadChannelListView: the unfurled per-group nested channel list rendered
 * directly below a group's row in the sidebar. Owns its own subscriptions
 * (channels store + uiState) so the parent only manages mount/unmount.
 *
 * Renders nothing for direct threads. For group threads: a small "CHANNELS"
 * header with an inline `+` to create, the implicit `#general` row, and
 * persisted named channels in order.
 */
export class ThreadChannelListView extends BusComponent {
  #threadId;
  #groupId;
  #createOpen;

  constructor({ bus, threadId, groupId } = {}) {
    super({ bus });
    this.#threadId = String(threadId || "").trim();
    this.#groupId = String(groupId || "").trim();
    this.#createOpen = false;
  }

  mount(parentEl) {
    super.mount(parentEl);
    if (!this._rootEl) return;
    const stores = this.bus.stores || {};
    if (stores.channels) {
      this._subscribe(stores.channels, (evt) => {
        const type = evt && typeof evt.type === "string" ? evt.type : "";
        const keys = evt && evt.keys ? evt.keys : {};
        if ((type === "channels.upserted" || type === "channels.removed") && keys.groupId !== this.#groupId) return;
        this.render();
      });
    }
    // Re-render when own role flips (member ↔ admin) so the "+" affordance
    // appears/disappears without needing a sidebar reload.
    if (stores.groups) {
      this._subscribe(stores.groups, (evt) => {
        const type = evt && typeof evt.type === "string" ? evt.type : "";
        const keys = evt && evt.keys ? evt.keys : {};
        if (type !== "groupMembers.replaced") return;
        if (keys.groupId !== this.#groupId) return;
        this.render();
      });
    }
    if (stores.threads) {
      this._subscribe(stores.threads, (evt) => {
        const keys = evt && evt.keys ? evt.keys : {};
        if (keys.threadId && keys.threadId !== this.#threadId) return;
        this.render();
      });
    }
    if (stores.uiState) {
      this._subscribe(stores.uiState, (evt) => {
        const type = evt && typeof evt.type === "string" ? evt.type : "";
        if (type === "ui.selectedThread.changed") {
          this.render();
          return;
        }
        if (type !== "ui.selectedChannel.changed") return;
        const keys = evt && evt.keys ? evt.keys : {};
        if (keys.threadId && keys.threadId !== this.#threadId) return;
        this.render();
      });
    }
    // Lazy-load on mount so the list populates as the group expands.
    if (!stores.channels.isLoaded(this.#groupId)) {
      this.bus.call("channels", "ensureList", { groupId: this.#groupId }).catch((err) => {
        console.error("[ThreadChannelListView] ensureList failed", err);
        this.bus.emit("app.error", { source: "ThreadChannelListView", message: "ensureList failed", severity: "warn", err });
      });
    }
    // Also lazy-load members — the "+" affordance is admin-gated, and without
    // members in the store `isAdmin` returns false even for true admins.
    if (!stores.groups.isMembersLoaded(this.#groupId)) {
      this.bus.call("groups", "ensureMembers", { groupId: this.#groupId }).catch((err) => {
        console.error("[ThreadChannelListView] ensureMembers failed", err);
        this.bus.emit("app.error", { source: "ThreadChannelListView", message: "ensureMembers failed", severity: "warn", err });
      });
    }
    this.render();
  }

  render() {
    if (!this._rootEl) return;
    if (!this.#groupId) {
      this._rootEl.replaceChildren();
      return;
    }
    const channels = this.bus.stores.channels.getChannels(this.#groupId);
    const activeChannelId = this.#activeChannelId();
    const unreadByChannelId = this.#unreadByChannelId();
    const viewerIsAdmin = this.bus.queries.groups.canSelfCreateChannel(this.#groupId);

    let addBtn = null;
    if (viewerIsAdmin) {
      addBtn = h("button", {
        type: "button",
        className: ADD_BTN_CLASS,
        title: "Create channel",
        "aria-label": "Create channel",
        "data-testid": "channel.add",
      }, [materialIcon("add", { size: 14 })]);
      addBtn.addEventListener("click", (evt) => {
        evt.stopPropagation();
        this.#createOpen = !this.#createOpen;
        this.render();
      });
    } else if (this.#createOpen) {
      // Lost admin since opening the create input — collapse it.
      this.#createOpen = false;
    }

    const header = h("div", { className: HEADER_CLASS }, [
      h("span", {}, "Channels"),
      addBtn,
    ]);

    const rows = [header];
    rows.push(this.#renderChannelRow({
      channelId: GENERAL_CHANNEL_ID,
      label: "general",
      active: activeChannelId === GENERAL_CHANNEL_ID,
      unreadCount: unreadByChannelId[GENERAL_CHANNEL_ID] || 0,
    }));
    for (const channel of channels) {
      const cid = channel.channelId;
      const display = channel.label && channel.label.trim() ? channel.label : cid;
      rows.push(this.#renderChannelRow({
        channelId: cid,
        label: display,
        active: activeChannelId === cid,
        unreadCount: unreadByChannelId[cid] || 0,
      }));
    }
    if (this.#createOpen) {
      rows.push(this.#renderCreateInput());
    }

    const section = h("div", {
      className: SECTION_CLASS,
      "data-testid": "channel.list",
      "data-group-id": this.#groupId,
    }, rows);
    this._rootEl.replaceChildren(section);
  }

  #renderChannelRow({ channelId, label, active, unreadCount }) {
    const hasUnread = !active && Number(unreadCount) > 0;
    const labelClass = hasUnread ? "text-on-surface font-medium" : "";
    const children = [
      h("span", { className: "opacity-40" }, "#"),
      h("span", { className: labelClass + " flex-1 min-w-0 truncate" }, label),
    ];
    if (hasUnread) {
      children.push(h("span", {
        className: "shrink-0 ml-1 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-primary text-on-primary text-label-micro font-label-technical",
        "data-testid": "channel.row.unread",
      }, String(Number(unreadCount))));
    }
    const row = h("div", {
      className: active ? ROW_ACTIVE_CLASS : ROW_BASE_CLASS,
      "data-channel-id": channelId,
      "data-testid": channelId === GENERAL_CHANNEL_ID ? "channel.row.general" : "channel.row",
    }, children);
    row.addEventListener("click", (evt) => {
      evt.stopPropagation();
      this.#selectChannel(channelId);
    });
    return row;
  }

  #unreadByChannelId() {
    const thread = this.bus.stores.threads.getThread(this.#threadId);
    if (!thread || !thread.unreadByChannelId || typeof thread.unreadByChannelId !== "object") return {};
    return thread.unreadByChannelId;
  }

  #renderCreateInput() {
    const input = h("input", {
      type: "text",
      className: "ml-12 mr-4 mt-1 px-2 py-1 rounded-md bg-surface-container border border-outline-variant/40 text-label-technical font-label-technical text-on-surface outline-none focus:border-primary/60 w-[calc(100%-4rem)]",
      placeholder: "Channel name",
      maxlength: 128,
      "data-testid": "channel.create.input",
    });
    const submit = () => {
      // Free-form label; server slugifies into channelId. Spaces, capitals,
      // emoji etc. are preserved for display.
      const value = String(input.value || "").trim();
      this.#createOpen = false;
      this.render();
      if (!value) return;
      const groupId = this.#groupId;
      this.bus.call("channels", "create", { groupId, label: value })
        .then((result) => {
          const newId = result && result.channel ? String(result.channel.channelId || "") : "";
          if (newId) this.#selectChannel(newId);
        })
        .catch((err) => {
          console.error("[ThreadChannelListView] create failed", err);
          this.bus.emit("app.error", {
            source: "ThreadChannelListView",
            message: "Couldn't create channel \"" + value + "\": " + ((err && err.message) || String(err)),
            severity: "warn",
            err,
          });
        });
    };
    input.addEventListener("click", (evt) => evt.stopPropagation());
    input.addEventListener("keydown", (evt) => {
      if (evt.key === "Enter") { evt.preventDefault(); submit(); }
      if (evt.key === "Escape") { evt.preventDefault(); this.#createOpen = false; this.render(); }
    });
    // No blur-to-close handler: blur fires when the input is detached by our
    // own re-render (channels.upserted from any group event reaches us), and
    // a delayed close after that races with submit and with the user clicking
    // back into the input. Escape and Enter are the explicit exits.
    setTimeout(() => { try { input.focus(); } catch (_err) { /* element gone */ } }, 0);
    return input;
  }

  #activeChannelId() {
    // Only surface a highlighted channel when this group's thread is the one
    // actually loaded in the chat panel. Unfurling a group's channel list in
    // the sidebar must not imply that #general is active.
    const uiState = this.bus.stores.uiState;
    if (uiState.selectedThreadId() !== this.#threadId) return null;
    return uiState.getSelectedChannelId(this.#threadId) || GENERAL_CHANNEL_ID;
  }

  #selectChannel(channelId) {
    const threadId = this.#threadId;
    // Update the active channel in uiState first so any subscriber
    // (composer, timeline filter) that reads from uiState during the
    // upcoming threads.select propagation sees the new selection.
    this.bus.call("ui", "selectChannel", { threadId, channelId }).catch((err) => {
      console.error("[ThreadChannelListView] selectChannel failed", err);
      this.bus.emit("app.error", { source: "ThreadChannelListView", message: "selectChannel failed", severity: "warn", err });
    });
    this.bus.call("threads", "select", { threadId, channelId }).catch((err) => {
      console.error("[ThreadChannelListView] select thread failed", err);
      this.bus.emit("app.error", { source: "ThreadChannelListView", message: "select thread failed", severity: "warn", err });
    });
  }
}
