import { h } from "@rezprotocol/ui";
import { BusComponent } from "../base/BusComponent.js";
import { materialIcon } from "../base/icon.js";
import { ellipsisId, avatarInitials, avatarHue } from "../presenters/labels.js";

const ROW_BASE_CLASS = "relative group/group w-full text-left flex items-center gap-space-md px-space-lg min-h-[64px] py-space-sm cursor-pointer transition-colors border-b border-outline-variant/20 hover:bg-surface-container/60";
const ACTION_WRAP_CLASS = "absolute right-2 top-1/2 -translate-y-1/2 opacity-0 group-hover/group:opacity-100 transition-opacity flex items-center gap-1 bg-surface-container-high/90 backdrop-blur-sm rounded-md p-0.5 border border-outline-variant/20";

export class GroupRowView extends BusComponent {
  #groupId;

  constructor({ bus, groupId } = {}) {
    super({ bus });
    this.#groupId = String(groupId || "").trim();
    if (!this.#groupId) throw new Error("GroupRowView requires groupId");
  }

  get groupId() {
    return this.#groupId;
  }

  mount(parentEl) {
    super.mount(parentEl);
    if (!this._rootEl) return;
    const stores = this.bus.stores || {};
    if (stores.groups) {
      this._subscribe(stores.groups, (evt) => {
        const type = evt && typeof evt.type === "string" ? evt.type : "";
        const keys = evt && evt.keys ? evt.keys : {};
        if (type === "groups.upserted" && keys.groupId !== this.#groupId) return;
        if (type === "groupMembers.replaced" && keys.groupId !== this.#groupId) return;
        this.render();
      });
    }
    if (stores.uiState) {
      this._subscribe(stores.uiState, (evt) => {
        const type = evt && typeof evt.type === "string" ? evt.type : "";
        if (type === "ui.selectedContactGroup.changed") this.render();
      });
    }
    this.render();
  }

  render() {
    if (!this._rootEl) return;
    const stores = this.bus.stores || {};
    const group = stores.groups ? stores.groups.getGroup(this.#groupId) : null;
    if (!group) {
      this._rootEl.replaceChildren();
      return;
    }
    const groupId = this.#groupId;
    const title = String(group.title || groupId || "").trim() || "Unnamed group";
    const memberCount = Number(group.memberCount || 0);
    const isSelected = stores.uiState.selectedContactGroupId() === groupId;

    const chatBtn = h("button", {
      type: "button",
      className: "w-7 h-7 flex items-center justify-center rounded text-on-surface-variant hover:text-primary hover:bg-primary/10 transition-colors",
      title: "Open chat",
      "aria-label": "Open chat",
      "data-thread-action": "chat",
    }, [materialIcon("chat", { size: 16 })]);
    chatBtn.addEventListener("click", (evt) => {
      evt.stopPropagation();
      const thread = this.bus.stores.threads.getThreadByGroupId(groupId);
      if (!thread) return;
      Promise.all([
        this.bus.call("ui", "navigateTab", { to: "chat" }),
        this.bus.call("threads", "select", { threadId: thread.threadId }),
      ]).catch((err) => {
        console.error("[GroupRowView] open group chat failed", err);
        this.bus.emit("app.error", { source: "GroupRowView", message: "open group chat failed", severity: "warn", err });
      });
    });

    const selectedClass = isSelected ? " bg-primary/10 border-l-2 border-l-primary" : "";
    const el = h("button", {
      type: "button",
      className: ROW_BASE_CLASS + selectedClass,
      "data-group-id": groupId,
    }, [
      h("div", {
        className: "w-10 h-10 rounded-lg flex items-center justify-center text-on-surface text-label-micro font-label-technical font-bold shrink-0",
        style: { background: "hsla(" + avatarHue(groupId) + ",55%,30%,0.9)" },
      }, avatarInitials(title)),
      h("div", { className: "flex flex-col flex-1 min-w-0" }, [
        h("p", { className: "text-on-surface text-body-base font-bold font-body-base truncate", "data-role": "group-label" }, title),
        memberCount > 0
          ? h("p", { className: "text-on-surface-variant/60 text-label-micro font-label-technical truncate mt-0.5" }, memberCount + " member" + (memberCount === 1 ? "" : "s"))
          : h("p", { className: "text-on-surface-variant/60 text-label-micro font-label-technical truncate mt-0.5" }, ellipsisId(groupId, 20)),
      ]),
      h("div", { className: ACTION_WRAP_CLASS }, [chatBtn]),
    ]);

    el.addEventListener("click", (evt) => {
      if (evt.target.closest("[data-thread-action]")) return;
      this.bus.call("ui", "selectContactGroup", { groupId }).catch((err) => {
        console.error("[GroupRowView] select contact group failed", err);
        this.bus.emit("app.error", { source: "GroupRowView", message: "select contact group failed", severity: "warn", err });
      });
    });

    this._rootEl.replaceChildren(el);
  }
}
