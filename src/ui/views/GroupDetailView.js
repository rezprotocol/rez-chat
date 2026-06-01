import { h } from "@rezprotocol/ui";
import { BusComponent } from "../base/BusComponent.js";
import { materialIcon } from "../base/icon.js";
import { ellipsisId, avatarInitials, avatarHue } from "../presenters/labels.js";
import { GroupMemberRowView } from "./GroupMemberRowView.js";
import { ConfirmModalView } from "./ConfirmModalView.js";
import { InviteCodeModalView } from "./InviteCodeModalView.js";

const STATE_NONE = "none";
const STATE_LOADING = "loading";
const STATE_EMPTY = "empty";
const STATE_LIST = "list";
const STATE_ERROR = "error";

const CARD_CLASS = "rounded-lg border border-outline-variant/30 bg-surface-container-low p-space-lg flex flex-col gap-space-md";
const HEADING_CLASS = "text-headline-sm font-headline-sm text-on-surface";

export class GroupDetailView extends BusComponent {
  #groupId;
  #onBack;
  #memberRowViews;
  #membersListEl;
  #membersHeaderEl;
  #membersState;
  #membersFetchToken;
  #titleEl;
  #containerEl;
  #renameBtn;
  #channelsCreateRow;

  constructor({ bus, groupId, onBack } = {}) {
    super({ bus });
    this.#groupId = String(groupId || "").trim();
    if (!this.#groupId) throw new Error("GroupDetailView requires groupId");
    this.#onBack = typeof onBack === "function" ? onBack : () => {};
    this.#memberRowViews = new Map();
    this.#membersListEl = null;
    this.#membersHeaderEl = null;
    this.#membersState = "";
    this.#membersFetchToken = 0;
    this.#titleEl = null;
    this.#containerEl = null;
    this.#renameBtn = null;
    this.#channelsCreateRow = null;
  }

  #syncAdminControls() {
    const queries = this.bus.queries;
    const canRename = queries && queries.groups ? queries.groups.canSelfRename(this.#groupId) : false;
    const canCreateChannel = queries && queries.groups ? queries.groups.canSelfCreateChannel(this.#groupId) : false;
    if (this.#renameBtn) {
      this.#renameBtn.style.display = canRename ? "" : "none";
    }
    if (this.#channelsCreateRow) {
      this.#channelsCreateRow.style.display = canCreateChannel ? "" : "none";
    }
  }

  mount(parentEl) {
    super.mount(parentEl);
    if (!this._rootEl) return;
    const stores = this.bus.stores || {};
    if (stores.groups) {
      this._subscribe(stores.groups, (evt) => this.#handleGroupsEvent(evt));
    }
    this.#renderShell();
    this.#refreshMembersFromStore();
    this.#kickoffMembersFetch();
  }

  #handleGroupsEvent(evt) {
    const type = evt && typeof evt.type === "string" ? evt.type : "";
    const keys = evt && evt.keys ? evt.keys : {};
    if (type === "groups.upserted" && keys.groupId === this.#groupId) {
      this.#refreshHeader();
      return;
    }
    if (type === "groups.removed" && keys.groupId === this.#groupId) {
      this.#onBack();
      return;
    }
    if (type === "groupMembers.replaced" && keys.groupId === this.#groupId) {
      this.#refreshMembersFromStore();
      this.#syncAdminControls();
    }
  }

  #renderShell() {
    if (!this._rootEl) return;
    const stores = this.bus.stores || {};
    const group = stores.groups ? stores.groups.getGroup(this.#groupId) : null;
    if (!group) { this.#onBack(); return; }
    const groupId = this.#groupId;
    const title = String(group.title || groupId || "").trim() || "Unnamed group";

    const content = h("div", { className: "p-space-lg md:p-space-xl flex flex-col gap-space-lg max-w-2xl overflow-y-auto custom-scrollbar h-full" }, []);

    const backBtn = h("button", {
      type: "button",
      className: "flex items-center gap-space-sm text-label-technical font-label-technical text-on-surface-variant hover:text-primary transition-colors cursor-pointer self-start",
    }, [materialIcon("arrow_back", { size: 16 }), document.createTextNode("Back")]);
    backBtn.addEventListener("click", () => this.#onBack());
    content.appendChild(backBtn);

    this.#titleEl = h("h3", { className: HEADING_CLASS, "data-role": "group-title" }, title);
    const renameBtn = h("button", {
      type: "button",
      className: "w-7 h-7 flex items-center justify-center rounded text-on-surface-variant hover:text-primary hover:bg-primary/10 transition-colors",
      title: "Rename group",
      "aria-label": "Rename group",
    }, [materialIcon("edit", { size: 16 })]);
    renameBtn.addEventListener("click", (evt) => { evt.stopPropagation(); this.#startInlineRename(); });
    this.#renameBtn = renameBtn;
    content.appendChild(h("div", { className: "flex items-center gap-space-md" }, [
      h("div", {
        className: "w-14 h-14 rounded-lg flex items-center justify-center text-on-surface text-body-sm font-body-sm font-bold shrink-0",
        style: { background: "hsla(" + avatarHue(groupId) + ",55%,30%,0.9)" },
      }, avatarInitials(title)),
      h("div", { className: "flex flex-col gap-1 flex-1 min-w-0" }, [
        h("div", { className: "flex items-center gap-space-sm" }, [this.#titleEl, renameBtn]),
        h("p", { className: "text-label-micro font-label-technical text-on-surface-variant/60" }, ellipsisId(groupId, 32)),
      ]),
    ]));

    const openChatBtn = h("button", {
      type: "button",
      className: "bg-primary-container text-on-primary-container px-space-lg py-2.5 rounded-lg font-label-technical text-label-technical font-bold hover:bg-primary hover:text-on-primary transition-all cursor-pointer self-start flex items-center gap-space-sm",
    }, [materialIcon("chat", { size: 16 }), document.createTextNode("Open chat")]);
    openChatBtn.addEventListener("click", () => this.#openGroupChat());
    content.appendChild(openChatBtn);

    this.#membersHeaderEl = h("h4", { className: HEADING_CLASS }, "Members");
    this.#membersListEl = h("div", { className: "flex flex-col" }, [
      h("p", { className: "text-label-technical font-label-technical text-on-surface-variant/60" }, "Loading members..."),
    ]);
    this.#membersState = STATE_LOADING;
    content.appendChild(h("section", { className: CARD_CLASS }, [
      this.#membersHeaderEl,
      this.#membersListEl,
    ]));

    content.appendChild(this.#buildInviteSection(title));

    content.appendChild(this.#buildChannelsSection());

    content.appendChild(this.#buildLeaveSection(title));

    this._rootEl.replaceChildren(content);
    this.#containerEl = content;
    this.#syncAdminControls();
  }

  #refreshHeader() {
    const stores = this.bus.stores || {};
    const group = stores.groups ? stores.groups.getGroup(this.#groupId) : null;
    if (!group) { this.#onBack(); return; }
    if (this.#titleEl) {
      this.#titleEl.textContent = String(group.title || this.#groupId || "").trim() || "Unnamed group";
    }
  }

  #kickoffMembersFetch() {
    const groupId = this.#groupId;
    const token = ++this.#membersFetchToken;
    this.bus.call("groups", "ensureMembers", { groupId, force: true }).catch((err) => {
      if (token !== this.#membersFetchToken || !this._rootEl) return;
      console.error("[GroupDetailView] fetch members failed", err);
      this.#renderMembersError();
    });
  }

  #refreshMembersFromStore() {
    if (!this.#membersListEl) return;
    const groupStore = this.bus.stores.groups;
    if (!groupStore.isMembersLoaded(this.#groupId)) return;
    const ids = groupStore.getMemberIds(this.#groupId);
    this.#updateMembersHeader(ids.length);

    if (ids.length === 0) {
      if (this.#membersState !== STATE_EMPTY) {
        this.#teardownMemberRows();
        this.#membersListEl.replaceChildren(h("p", { className: "text-label-technical font-label-technical text-on-surface-variant/60" }, "No members found."));
        this.#membersState = STATE_EMPTY;
      }
      return;
    }

    if (this.#membersState !== STATE_LIST) {
      this.#membersListEl.replaceChildren();
      this.#membersState = STATE_LIST;
    }

    const desiredSet = new Set(ids);
    for (const [id, view] of [...this.#memberRowViews]) {
      if (!desiredSet.has(id)) {
        view.unmount();
        this.#memberRowViews.delete(id);
      }
    }

    let cursor = this.#membersListEl.firstChild;
    for (const memberId of ids) {
      let view = this.#memberRowViews.get(memberId);
      let row;
      if (!view) {
        view = new GroupMemberRowView({ bus: this.bus, groupId: this.#groupId, accountId: memberId });
        row = document.createElement("div");
        row.dataset.memberId = memberId;
        view.mount(row);
        this.#memberRowViews.set(memberId, view);
        this.#membersListEl.insertBefore(row, cursor);
      } else {
        row = this.#membersListEl.querySelector('[data-member-id="' + cssEscape(memberId) + '"]');
        if (!row) {
          view.unmount();
          view = new GroupMemberRowView({ bus: this.bus, groupId: this.#groupId, accountId: memberId });
          row = document.createElement("div");
          row.dataset.memberId = memberId;
          view.mount(row);
          this.#memberRowViews.set(memberId, view);
          this.#membersListEl.insertBefore(row, cursor);
        } else if (row !== cursor) {
          this.#membersListEl.insertBefore(row, cursor);
        }
      }
      cursor = row.nextSibling;
    }
  }

  #updateMembersHeader(count) {
    if (!this.#membersHeaderEl) return;
    this.#membersHeaderEl.textContent = "Members (" + count + ")";
  }

  #renderMembersError() {
    if (!this.#membersListEl) return;
    this.#teardownMemberRows();
    this.#updateMembersHeader(0);
    this.#membersListEl.replaceChildren(h("p", { className: "text-label-technical font-label-technical text-error" }, "Failed to load members."));
    this.#membersState = STATE_ERROR;
  }

  #teardownMemberRows() {
    for (const view of this.#memberRowViews.values()) view.unmount();
    this.#memberRowViews.clear();
  }

  #startInlineRename() {
    if (!this.#titleEl) return;
    const currentName = this.#titleEl.textContent;
    const groupId = this.#groupId;
    const input = h("input", {
      type: "text", value: currentName,
      className: "bg-surface-container-high border border-primary/60 rounded px-space-sm py-0.5 text-headline-sm font-headline-sm text-on-surface outline-none w-full",
    });
    const titleEl = this.#titleEl;
    titleEl.replaceWith(input);
    input.focus();
    input.select();
    const restore = (text) => {
      const restored = h("h3", { className: HEADING_CLASS, "data-role": "group-title" }, text);
      input.replaceWith(restored);
      this.#titleEl = restored;
    };
    const commit = () => {
      const newName = String(input.value || "").trim();
      restore(newName || currentName);
      if (newName && newName !== currentName) {
        this.bus.call("groups", "rename", { groupId, title: newName }).catch((err) => {
          console.error("[GroupDetailView] rename failed", err);
          this.bus.emit("app.error", { source: "GroupDetailView", message: "rename failed", severity: "warn", err });
          if (this.#titleEl) this.#titleEl.textContent = currentName;
        });
      }
    };
    const cancel = () => restore(currentName);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); commit(); }
      if (e.key === "Escape") { e.preventDefault(); cancel(); }
    });
    input.addEventListener("blur", commit);
  }

  #openGroupChat() {
    const thread = this.bus.stores.threads.getThreadByGroupId(this.#groupId);
    if (!thread) return;
    Promise.all([
      this.bus.call("ui", "navigateTab", { to: "chat" }),
      this.bus.call("threads", "select", { threadId: thread.threadId }),
    ]).catch((err) => {
      console.error("[GroupDetailView] open group chat failed", err);
      this.bus.emit("app.error", { source: "GroupDetailView", message: "open group chat failed", severity: "warn", err });
    });
  }

  #buildInviteSection(title) {
    const groupId = this.#groupId;
    const section = h("section", {
      className: CARD_CLASS,
      "data-testid": "group.invite.section",
    }, []);
    const headerEl = h("h4", { className: HEADING_CLASS }, "Invite");
    const helpEl = h("p", {
      className: "text-body-sm font-body-sm text-on-surface-variant/70",
    }, "Generate a fresh invite code to add someone to this group.");
    const errorEl = h("p", {
      className: "hidden text-label-micro font-label-technical text-error",
    }, "");
    const generateBtn = h("button", {
      type: "button",
      className: "bg-primary-container text-on-primary-container px-space-lg py-2.5 rounded-lg font-label-technical text-label-technical font-bold hover:bg-primary hover:text-on-primary transition-all cursor-pointer self-start flex items-center gap-space-sm",
      "data-testid": "group.invite.generate",
    }, [materialIcon("person_add", { size: 16 }), document.createTextNode("Generate invite code")]);
    generateBtn.addEventListener("click", () => {
      generateBtn.disabled = true;
      const restore = () => { generateBtn.disabled = false; };
      errorEl.classList.add("hidden");
      this.bus.call("invites", "createForGroup", { groupId, title: title || null }).then((invite) => {
        const code = invite && invite.inviteCode ? String(invite.inviteCode) : "";
        const modal = new InviteCodeModalView({
          bus: this.bus,
          inviteCode: code,
          title: "Group invite",
          subtitle: title
            ? "Share this code so someone can join \"" + title + "\"."
            : "Share this code so someone can join the group.",
        });
        modal.open();
      }).catch((err) => {
        console.error("[GroupDetailView] generate group invite failed", err);
        errorEl.textContent = err && err.message ? err.message : "Failed to generate invite.";
        errorEl.classList.remove("hidden");
        this.bus.emit("app.error", { source: "GroupDetailView", message: "generate group invite failed", severity: "warn", err });
      }).finally(restore);
    });
    section.appendChild(headerEl);
    section.appendChild(helpEl);
    section.appendChild(generateBtn);
    section.appendChild(errorEl);
    return section;
  }

  #buildChannelsSection() {
    const groupId = this.#groupId;
    const section = h("section", {
      className: CARD_CLASS,
      "data-testid": "group.channels.section",
    }, []);
    const headerEl = h("h4", { className: HEADING_CLASS }, "Channels");
    const listEl = h("div", { className: "flex flex-col gap-space-sm" }, []);
    const createRow = h("div", { className: "flex items-center gap-space-sm pt-space-sm border-t border-outline-variant/20" }, []);
    section.appendChild(headerEl);
    section.appendChild(listEl);
    section.appendChild(createRow);
    this.#channelsCreateRow = createRow;

    const channelStore = this.bus.stores.channels;
    const queries = this.bus.queries;

    const renderList = () => {
      const channels = channelStore.getChannels(groupId);
      const rows = [
        h("div", {
          className: "flex items-center justify-between gap-space-md py-1.5 px-space-sm rounded text-label-technical font-label-technical text-on-surface-variant",
        }, [
          h("span", {}, [h("span", { className: "text-outline mr-1" }, "#"), "general"]),
          h("span", { className: "text-label-micro text-outline/60" }, "default · undeletable"),
        ]),
      ];
      for (const channel of channels) {
        const display = channel.label && String(channel.label).trim() ? channel.label : channel.channelId;
        const row = h("div", {
          className: "flex items-center justify-between gap-space-md py-1.5 px-space-sm rounded hover:bg-surface-container/40 group/channel",
          "data-testid": "group.channel.row",
          "data-channel-id": channel.channelId,
        }, [
          h("span", { className: "text-label-technical font-label-technical text-on-surface" }, [
            h("span", { className: "text-outline mr-1" }, "#"),
            display,
          ]),
          (queries && queries.groups && queries.groups.canSelfDeleteChannel(groupId, channel.channelId)) ? (() => {
            const delBtn = h("button", {
              type: "button",
              className: "opacity-0 group-hover/channel:opacity-100 w-7 h-7 flex items-center justify-center rounded text-on-surface-variant hover:text-error hover:bg-error/10 transition-colors",
              title: "Delete channel",
              "aria-label": "Delete channel",
              "data-testid": "group.channel.delete",
            }, [materialIcon("delete", { size: 14 })]);
            delBtn.addEventListener("click", (evt) => {
              evt.stopPropagation();
              const modal = new ConfirmModalView({
                bus: this.bus,
                title: "Delete channel",
                message: "Delete channel \"#" + display + "\"? Members will lose it from their channel list, but historical messages remain in the group's archive.",
                confirmLabel: "Delete",
                variant: "danger",
                onConfirm: () => {
                  this.bus.call("channels", "delete", { groupId, channelId: channel.channelId }).catch((err) => {
                    console.error("[GroupDetailView] channel delete failed", err);
                    this.bus.emit("app.error", { source: "GroupDetailView", message: "channel delete failed", severity: "warn", err });
                  });
                },
              });
              modal.open();
            });
            return delBtn;
          })() : null,
        ]);
        rows.push(row);
      }
      listEl.replaceChildren(...rows);
    };

    const renderCreate = () => {
      createRow.replaceChildren();
      const input = h("input", {
        type: "text",
        className: "flex-1 px-space-sm py-1.5 rounded bg-surface-container border border-outline-variant/40 text-label-technical font-label-technical text-on-surface outline-none focus:border-primary/60",
        placeholder: "new-channel-slug",
        maxlength: 64,
        "data-testid": "group.channel.create.input",
      });
      const addBtn = h("button", {
        type: "button",
        className: "px-space-md py-1.5 rounded bg-primary-container text-on-primary-container text-label-technical font-label-technical font-bold hover:bg-primary hover:text-on-primary transition-colors",
      }, [materialIcon("add", { size: 14 }), document.createTextNode("Add")]);
      const submit = () => {
        const value = String(input.value || "").trim().toLowerCase();
        if (!value) return;
        this.bus.call("channels", "create", { groupId, channelId: value })
          .then(() => { input.value = ""; })
          .catch((err) => {
            console.error("[GroupDetailView] channel create failed", err);
            this.bus.emit("app.error", { source: "GroupDetailView", message: "channel create failed", severity: "warn", err });
          });
      };
      addBtn.addEventListener("click", submit);
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); submit(); }
      });
      createRow.appendChild(input);
      createRow.appendChild(addBtn);
    };

    renderList();
    renderCreate();

    // Lazy-load + subscribe so the section reacts to live channel updates.
    this._channelsOff = channelStore.subscribe((evt) => {
      const type = evt && typeof evt.type === "string" ? evt.type : "";
      const keys = evt && evt.keys ? evt.keys : {};
      if (
        (type === "channels.upserted" || type === "channels.removed" || type === "channels.replaced")
        && (!keys.groupId || keys.groupId === groupId)
      ) {
        renderList();
      }
    });
    if (!channelStore.isLoaded(groupId)) {
      this.bus.call("channels", "ensureList", { groupId }).catch((err) => {
        console.error("[GroupDetailView] channels.ensureList failed", err);
        this.bus.emit("app.error", { source: "GroupDetailView", message: "channels.ensureList failed", severity: "warn", err });
      });
    }

    return section;
  }

  #buildLeaveSection(title) {
    const groupId = this.#groupId;
    const section = h("section", {
      className: "rounded-lg border border-error/30 bg-error/5 p-space-lg flex flex-col gap-space-md",
    }, [
      h("h4", { className: "text-headline-sm font-headline-sm text-error" }, "Danger Zone"),
    ]);
    const leaveBtn = h("button", {
      type: "button",
      className: "bg-error/15 border border-error/50 px-space-lg py-2.5 rounded-lg text-error font-label-technical text-label-technical font-bold hover:bg-error hover:text-on-error transition-all cursor-pointer self-start flex items-center gap-space-sm",
    }, [materialIcon("logout", { size: 16 }), document.createTextNode("Leave group")]);
    leaveBtn.addEventListener("click", () => {
      const modal = new ConfirmModalView({
        bus: this.bus,
        title: "Leave group",
        message: "Are you sure you want to leave \"" + title + "\"? You will need a new invite to rejoin.",
        confirmLabel: "Leave",
        variant: "danger",
        onConfirm: () => {
          this.bus.call("groups", "leave", { groupId }).then(() => this.#onBack()).catch((err) => {
            console.error("[GroupDetailView] leave failed", err);
            this.bus.emit("app.error", { source: "GroupDetailView", message: "leave failed", severity: "warn", err });
          });
        },
      });
      modal.open();
    });
    section.appendChild(leaveBtn);
    return section;
  }

  unmount() {
    this.#teardownMemberRows();
    if (typeof this._channelsOff === "function") {
      this._channelsOff();
      this._channelsOff = null;
    }
    this.#membersListEl = null;
    this.#membersHeaderEl = null;
    this.#titleEl = null;
    this.#containerEl = null;
    this.#renameBtn = null;
    this.#channelsCreateRow = null;
    this.#membersState = STATE_NONE;
    super.unmount();
  }
}

function cssEscape(value) {
  if (typeof CSS !== "undefined" && CSS && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}
