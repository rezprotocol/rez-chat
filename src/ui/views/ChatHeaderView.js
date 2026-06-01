import { h } from "@rezprotocol/ui";
import { BusComponent } from "../base/BusComponent.js";
import { materialIcon } from "../base/icon.js";
import { ContactAvatarView } from "./ContactAvatarView.js";
import { ConfirmModalView } from "./ConfirmModalView.js";
import { InviteCodeModalView } from "./InviteCodeModalView.js";
import { shortId } from "../presenters/labels.js";

export class ChatHeaderView extends BusComponent {
  #avatarView;
  #membersOpen;
  #overflowOpen;
  #outsideClickHandler;

  constructor({ bus } = {}) {
    super({ bus });
    this.#avatarView = null;
    this.#membersOpen = false;
    this.#overflowOpen = false;
    this.#outsideClickHandler = null;
  }

  mount(parentEl) {
    super.mount(parentEl);
    if (!this._rootEl) return;
    const stores = this.bus.stores || {};
    if (stores.uiState) {
      this._subscribe(stores.uiState, (evt) => {
        const type = evt && typeof evt.type === "string" ? evt.type : "";
        if (type === "ui.selectedThread.changed") {
          this.#membersOpen = false;
          this.#overflowOpen = false;
          this.render();
        } else if (type === "ui.selectedChannel.changed") {
          this.render();
        }
      });
    }
    if (stores.threads) {
      this._subscribe(stores.threads, (evt) => {
        const type = evt && typeof evt.type === "string" ? evt.type : "";
        const keys = evt && evt.keys ? evt.keys : {};
        const selectedId = this.#selectedThreadId();
        if (!selectedId) return;
        if (type === "threads.upserted" && keys.threadId !== selectedId) return;
        if (type === "threads.removed" && keys.threadId !== selectedId) return;
        this.render();
      });
    }
    if (stores.contacts) {
      this._subscribe(stores.contacts, (evt) => {
        const type = evt && typeof evt.type === "string" ? evt.type : "";
        const keys = evt && evt.keys ? evt.keys : {};
        const peerId = this.#selectedPeerAccountId();
        if (peerId && type === "contacts.upserted" && keys.accountId !== peerId) return;
        this.render();
      });
    }
    if (stores.groups) {
      this._subscribe(stores.groups, (evt) => {
        const type = evt && typeof evt.type === "string" ? evt.type : "";
        const keys = evt && evt.keys ? evt.keys : {};
        const groupId = this.#selectedGroupId();
        if (!groupId) return;
        if (type === "groups.upserted" && keys.groupId !== groupId) return;
        if (type === "groupMembers.replaced" && keys.groupId !== groupId) return;
        this.render();
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

  #selectedThreadId() {
    const queries = this.bus.queries;
    if (!queries || !queries.threads) return "";
    return queries.threads.selectedThreadId() || "";
  }

  #selectedThread() {
    const stores = this.bus.stores || {};
    const threadId = this.#selectedThreadId();
    if (!threadId || !stores.threads) return null;
    return stores.threads.getThread(threadId);
  }

  #selectedGroupId() {
    const thread = this.#selectedThread();
    return thread && thread.groupId ? String(thread.groupId) : "";
  }

  #selectedPeerAccountId() {
    const thread = this.#selectedThread();
    return thread && thread.peerAccountId ? String(thread.peerAccountId) : "";
  }

  #selectedChannelId(threadId) {
    return this.bus.stores.uiState.getSelectedChannelId(threadId) || "";
  }

  render() {
    if (!this._rootEl) return;
    const stores = this.bus.stores || {};
    const queries = this.bus.queries || {};
    const threadId = this.#selectedThreadId();
    if (!threadId || !stores.threads) {
      this.#renderEmpty();
      return;
    }
    const thread = stores.threads.getThread(threadId);
    if (!thread) {
      this.#renderEmpty();
      return;
    }

    const contactStore = stores.contacts || null;
    const groupStore = stores.groups || null;
    const contact = thread.peerAccountId && contactStore ? contactStore.getContact(thread.peerAccountId) : null;
    const members = this.#membersOpen && thread.groupId && groupStore ? groupStore.getMembers(thread.groupId) : [];
    const title = (queries.threads ? queries.threads.displayLabel(threadId) : null) || shortId(threadId, 16);
    const locked = String(thread.accessState || "open").toLowerCase() === "locked";
    const archived = String(thread.visibilityState || "visible").toLowerCase() === "hidden";

    // Lazy-load members for any group thread (not only when the panel is
    // open) — admin gates in the overflow menu read from groupStore.isAdmin
    // which returns false until members are loaded.
    if (thread.groupId && groupStore && !groupStore.isMembersLoaded(thread.groupId)) {
      this.bus.call("groups", "ensureMembers", { groupId: thread.groupId }).catch((err) => {
        console.error("[ChatHeaderView] ensureMembers failed", err);
      });
    }

    const contactAvatarHash = contact && typeof contact.avatarFileHash === "string" ? contact.avatarFileHash : "";
    const avatarSlot = h("div", { className: "w-10 h-10 rounded-full overflow-hidden" });

    if (this.#avatarView) {
      this.#avatarView.unmount();
    }
    this.#avatarView = new ContactAvatarView({
      bus: this.bus,
      label: title || threadId,
      fileHashHex: contactAvatarHash,
      sizeClass: "w-full h-full",
      roundedClass: "rounded-full",
    });

    const backBtn = h("button", {
      type: "button",
      className: "lg:hidden shrink-0 w-9 h-9 -ml-1 flex items-center justify-center rounded text-on-surface-variant hover:text-primary hover:bg-primary/5 transition-colors",
      title: "Back to messages",
      "aria-label": "Back to messages",
      "data-role": "chat-back",
    }, [materialIcon("arrow_back", { size: 20 })]);
    backBtn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      this.bus.call("threads", "deselect", {}).catch((err) => {
        console.error("[ChatHeaderView] deselect failed", err);
        this.bus.emit("app.error", { source: "ChatHeaderView", message: "deselect thread failed", severity: "warn", err });
      });
    });

    const subtitleSegments = [];
    if (thread.threadType === "group") {
      const activeChannelId = this.#selectedChannelId(threadId);
      const channelLabel = queries.channels
        ? "#" + queries.channels.displayLabel(thread.groupId, activeChannelId)
        : "#general";
      subtitleSegments.push(channelLabel);
    }
    if (locked) subtitleSegments.push("LOCKED");
    else if (thread.threadReady === false) subtitleSegments.push("PENDING");
    const subtitleText = subtitleSegments.join(" · ");
    const subtitleTone = (locked || thread.threadReady === false) ? "text-error/70" : "text-primary/70";

    const header = h("header", {
      className: "h-16 flex justify-between items-center px-space-md md:px-space-lg backdrop-blur-md border-b border-outline-variant/30 sticky top-0 z-40 bg-surface-dim/70 titlebar-drag relative min-w-0",
    }, [
      h("div", { className: "flex items-center gap-4 min-w-0" }, [
        backBtn,
        h("div", { className: "shrink-0" }, [avatarSlot]),
        h("div", { className: "min-w-0" }, [
          h("h2", { className: "text-body-base font-semibold text-on-surface truncate" }, title),
          subtitleText
            ? h("span", { className: "text-label-micro font-label-technical uppercase tracking-[0.15em] " + subtitleTone }, subtitleText)
            : null,
        ]),
      ]),
      this.#buildActions(thread, locked, archived),
      this.#membersOpen && members.length > 0 ? this.#buildMembersPanel(members) : null,
      this.#overflowOpen ? this.#buildOverflowMenu(threadId, locked, archived, thread.groupId || null, this.#selectedChannelId(threadId), queries.groups ? queries.groups.isSelfAdmin(thread.groupId || "") : false) : null,
    ]);

    this.#bindActions(header, threadId, locked, archived, thread.groupId || null, this.#selectedChannelId(threadId));
    this._rootEl.replaceChildren(header);
    this.#avatarView.mount(avatarSlot);
    this.#syncOutsideClickHandler(header);
  }

  #syncOutsideClickHandler(headerEl) {
    const shouldListen = this.#membersOpen || this.#overflowOpen;
    if (!shouldListen) {
      this.#removeOutsideClickHandler();
      return;
    }
    this.#removeOutsideClickHandler();
    const handler = (ev) => {
      if (!headerEl || !headerEl.isConnected) {
        this.#removeOutsideClickHandler();
        return;
      }
      if (headerEl.contains(ev.target)) return;
      this.#membersOpen = false;
      this.#overflowOpen = false;
      this.render();
    };
    this.#outsideClickHandler = handler;
    document.addEventListener("mousedown", handler, true);
  }

  #removeOutsideClickHandler() {
    if (!this.#outsideClickHandler) return;
    document.removeEventListener("mousedown", this.#outsideClickHandler, true);
    this.#outsideClickHandler = null;
  }

  #renderEmpty() {
    if (this.#avatarView) {
      this.#avatarView.unmount();
      this.#avatarView = null;
    }
    this._rootEl.replaceChildren(h("header", {
      className: "h-16 flex items-center justify-between px-space-md md:px-space-lg backdrop-blur-md border-b border-outline-variant/30 sticky top-0 z-40 bg-surface-dim/70 titlebar-drag",
    }, [
      h("div", { className: "flex flex-col min-w-0" }, [
        h("p", { className: "text-label-micro font-label-technical text-outline uppercase tracking-[0.15em]" }, "Conversation"),
        h("h2", { className: "text-body-base font-semibold text-on-surface truncate" }, "Select a conversation"),
      ]),
    ]));
  }

  #buildActions(thread, locked, archived) {
    const iconBtn = (iconName, title, action, opts = {}) => h("button", {
      type: "button",
      className: "p-2 rounded-lg text-on-surface-variant hover:text-primary transition-opacity opacity-80 hover:opacity-100",
      title,
      "aria-label": title,
      "data-action": action,
      "data-action-payload": opts.payload || "",
    }, [materialIcon(iconName, { size: 22 })]);

    return h("div", { className: "flex items-center gap-2 shrink-0" }, [
      thread.groupId ? iconBtn("groups", "Members", "thread.members.toggle") : null,
      iconBtn("more_vert", "More actions", "thread.overflow.toggle"),
    ]);
  }

  #buildOverflowMenu(threadId, locked, archived, groupId, activeChannelId, isGroupAdmin) {
    const item = (iconName, label, action, danger = false) => {
      const btn = h("button", {
        type: "button",
        className: (danger
          ? "w-full flex items-center gap-3 px-3 py-2 rounded-md text-error hover:bg-error/10 transition-colors"
          : "w-full flex items-center gap-3 px-3 py-2 rounded-md text-on-surface hover:bg-primary/5 hover:text-primary transition-colors"),
        "data-action": action,
      }, [
        materialIcon(iconName, { size: 18 }),
        h("span", { className: "text-body-sm font-body-sm" }, label),
      ]);
      return btn;
    };
    // For group threads viewing a named channel, the destructive action is
    // scoped to that channel (channels.delete) and admin-only. #general
    // (empty channelId) and the thread itself are not deletable from this
    // menu — the only group-wide action is "Leave group" via Group Info.
    // For direct (1:1) threads, "Delete" still deletes the thread.
    const isGroup = !!groupId;
    const channelKey = typeof activeChannelId === "string" ? activeChannelId.trim() : "";
    let deleteItem = null;
    if (!isGroup) {
      deleteItem = item("delete", "Delete", "thread.delete", true);
    } else if (channelKey && isGroupAdmin) {
      deleteItem = item("delete", "Delete channel", "channel.delete", true);
    }
    // Lock/archive on a group thread mutate state every member sees, so they
    // are admin-only. For DMs they remain available — the user owns their
    // own 1:1 view.
    const canMutateThreadState = !isGroup || isGroupAdmin;
    return h("div", {
      className: "absolute right-2 top-[calc(100%+4px)] z-30 w-56 rounded-xl border border-outline-variant/30 bg-surface-container/95 backdrop-blur-md shadow-xl p-1.5",
      "data-role": "header-overflow",
    }, [
      canMutateThreadState ? item(locked ? "lock_open" : "lock", locked ? "Unlock thread" : "Lock thread", "thread.lock.toggle") : null,
      canMutateThreadState ? item(archived ? "unarchive" : "archive", archived ? "Unarchive" : "Archive", "thread.archive.toggle") : null,
      groupId ? item("person_add", "Generate invite", "thread.invite.create") : null,
      groupId ? item("info", "Group info", "thread.info") : null,
      deleteItem ? h("div", { className: "h-px bg-outline-variant/20 my-1 mx-2" }) : null,
      deleteItem,
    ]);
  }

  #buildMembersPanel(members) {
    const queries = this.bus.queries;
    return h("div", {
      className: "absolute right-2 top-[calc(100%+4px)] z-30 w-80 rounded-xl border border-outline-variant/30 bg-surface-container/95 backdrop-blur-md shadow-xl p-3",
    }, [
      h("p", { className: "text-label-micro font-label-technical text-outline uppercase tracking-[0.15em] mb-2" }, "Members"),
      h("div", { className: "text-body-sm text-on-surface font-body-sm whitespace-pre-wrap" }, members.map((member) => {
        const mid = String(member.accountId || "").trim();
        if (!mid) return "Account";
        const name = queries && queries.contacts ? queries.contacts.displayName(mid) : null;
        return name || shortId(mid, 12);
      }).join("\n")),
    ]);
  }

  #bindActions(header, threadId, locked, archived, groupId, activeChannelId) {
    const membersButton = header.querySelector("[data-action='thread.members.toggle']");
    if (membersButton) {
      membersButton.addEventListener("click", (ev) => {
        ev.stopPropagation();
        this.#membersOpen = !this.#membersOpen;
        this.#overflowOpen = false;
        this.render();
      });
    }
    const overflowBtn = header.querySelector("[data-action='thread.overflow.toggle']");
    if (overflowBtn) {
      overflowBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        this.#overflowOpen = !this.#overflowOpen;
        this.#membersOpen = false;
        this.render();
      });
    }
    const lockButton = header.querySelector("[data-action='thread.lock.toggle']");
    if (lockButton) {
      lockButton.addEventListener("click", () => {
        this.#overflowOpen = false;
        this.bus.call("threads", "setState", {
          threadId,
          accessState: locked ? "open" : "locked",
        }).catch((err) => {
          console.error("[ChatHeaderView] set thread state failed", err);
          this.bus.emit("app.error", { source: "ChatHeaderView", message: "set thread state failed", severity: "warn", err });
        });
      });
    }
    const archiveButton = header.querySelector("[data-action='thread.archive.toggle']");
    if (archiveButton) {
      archiveButton.addEventListener("click", () => {
        this.#overflowOpen = false;
        this.bus.call("threads", "setState", {
          threadId,
          visibilityState: archived ? "visible" : "hidden",
        }).catch((err) => {
          console.error("[ChatHeaderView] archive toggle failed", err);
          this.bus.emit("app.error", { source: "ChatHeaderView", message: "archive toggle failed", severity: "warn", err });
        });
      });
    }
    const inviteButton = header.querySelector("[data-action='thread.invite.create']");
    if (inviteButton && groupId) {
      inviteButton.addEventListener("click", () => {
        this.#overflowOpen = false;
        this.render();
        const group = this.bus.stores.groups.getGroup(groupId);
        const groupTitle = group && group.title ? String(group.title).trim() : "";
        this.bus.call("invites", "createForGroup", { groupId, title: groupTitle || null }).then((invite) => {
          const code = invite && invite.inviteCode ? String(invite.inviteCode) : "";
          const modal = new InviteCodeModalView({
            bus: this.bus,
            inviteCode: code,
            title: "Group invite",
            subtitle: groupTitle
              ? "Share this code so someone can join \"" + groupTitle + "\"."
              : "Share this code so someone can join the group.",
          });
          modal.open();
        }).catch((err) => {
          console.error("[ChatHeaderView] generate group invite failed", err);
          this.bus.emit("app.error", { source: "ChatHeaderView", message: "generate group invite failed", severity: "warn", err });
        });
      });
    }
    const infoButton = header.querySelector("[data-action='thread.info']");
    if (infoButton && groupId) {
      infoButton.addEventListener("click", () => {
        this.#overflowOpen = false;
        this.bus.call("ui", "navigateTab", { to: "contacts" })
          .then(() => this.bus.call("ui", "selectContactGroup", { groupId }))
          .catch((err) => {
            console.error("[ChatHeaderView] open group info failed", err);
            this.bus.emit("app.error", { source: "ChatHeaderView", message: "open group info failed", severity: "warn", err });
          });
      });
    }
    const deleteButton = header.querySelector("[data-action='thread.delete']");
    if (deleteButton) {
      deleteButton.addEventListener("click", () => {
        this.#overflowOpen = false;
        this.bus.call("threads", "delete", { threadId }).catch((err) => {
          console.error("[ChatHeaderView] delete failed", err);
          this.bus.emit("app.error", { source: "ChatHeaderView", message: "delete failed", severity: "warn", err });
        });
      });
    }
    const channelDeleteButton = header.querySelector("[data-action='channel.delete']");
    if (channelDeleteButton && groupId) {
      const channelKey = typeof activeChannelId === "string" ? activeChannelId.trim() : "";
      channelDeleteButton.addEventListener("click", () => {
        this.#overflowOpen = false;
        this.render();
        if (!channelKey) return;
        const queries = this.bus.queries;
        const display = queries && queries.channels ? queries.channels.displayLabel(groupId, channelKey) : channelKey;
        const modal = new ConfirmModalView({
          bus: this.bus,
          title: "Delete channel",
          message: "Delete channel \"#" + display + "\"? Members will lose it from their channel list, but historical messages remain in the group's archive.",
          confirmLabel: "Delete",
          variant: "danger",
          onConfirm: () => {
            this.bus.call("channels", "delete", { groupId, channelId: channelKey }).catch((err) => {
              console.error("[ChatHeaderView] channel delete failed", err);
              this.bus.emit("app.error", { source: "ChatHeaderView", message: "channel delete failed", severity: "warn", err });
            });
          },
        });
        modal.open();
      });
    }
  }

  unmount() {
    this.#removeOutsideClickHandler();
    if (this.#avatarView) {
      this.#avatarView.unmount();
      this.#avatarView = null;
    }
    super.unmount();
  }
}
