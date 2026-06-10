import { h } from "@rezprotocol/ui";
import { BusComponent } from "../base/BusComponent.js";
import { materialIcon } from "../base/icon.js";
import { ellipsisId, avatarInitials, avatarHue } from "../presenters/labels.js";
import { ConfirmModalView } from "./ConfirmModalView.js";

const ACTION_BTN_CLASS = "w-7 h-7 flex items-center justify-center rounded text-on-surface-variant hover:text-primary hover:bg-primary/10 transition-colors";
const ACTION_BTN_DANGER_CLASS = "w-7 h-7 flex items-center justify-center rounded text-on-surface-variant hover:text-error hover:bg-error/10 transition-colors";

export class GroupMemberRowView extends BusComponent {
  #groupId;
  #memberId;

  constructor({ bus, groupId, accountId } = {}) {
    super({ bus });
    this.#groupId = String(groupId || "").trim();
    this.#memberId = String(accountId || "").trim();
    if (!this.#groupId) throw new Error("GroupMemberRowView requires groupId");
    if (!this.#memberId) throw new Error("GroupMemberRowView requires accountId");
  }

  get accountId() {
    return this.#memberId;
  }

  mount(parentEl) {
    super.mount(parentEl);
    if (!this._rootEl) return;
    const stores = this.bus.stores || {};
    if (stores.groups) {
      this._subscribe(stores.groups, (evt) => {
        const type = evt && typeof evt.type === "string" ? evt.type : "";
        const keys = evt && evt.keys ? evt.keys : {};
        if (type !== "groupMembers.replaced") return;
        if (keys.groupId !== this.#groupId) return;
        this.render();
      });
    }
    if (stores.contacts) {
      this._subscribe(stores.contacts, (evt) => {
        const type = evt && typeof evt.type === "string" ? evt.type : "";
        const keys = evt && evt.keys ? evt.keys : {};
        if (type === "contacts.upserted" && keys.accountId !== this.#memberId) return;
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

  render() {
    if (!this._rootEl) return;
    const groupStore = this.bus.stores.groups;
    const queries = this.bus.queries;
    if (!groupStore) {
      this._rootEl.replaceChildren();
      return;
    }

    const memberId = this.#memberId;
    const member = groupStore.getMember(this.#groupId, memberId);
    if (!member) {
      this._rootEl.replaceChildren();
      return;
    }

    const memberDisplayName = typeof member.displayName === "string" ? member.displayName.trim() : "";
    const contactName = queries.contacts.displayName(memberId);
    const name = memberDisplayName || contactName || memberId;

    const isAdmin = groupStore.isAdmin(this.#groupId, memberId);
    const canManage = queries.groups.canSelfSetRole(this.#groupId, memberId);

    const actions = h("div", { className: "flex items-center gap-1 shrink-0" }, []);
    const session = this.bus.stores.session;
    const isSelf = session && typeof session.isSelf === "function" && session.isSelf(memberId);
    const contactStore = this.bus.stores.contacts;
    const contact = contactStore && typeof contactStore.getContact === "function" ? contactStore.getContact(memberId) : null;
    const relState = contact ? contact.relationshipState : null;
    if (!isSelf && relState !== "active" && relState !== "blocked") {
      actions.appendChild(relState === "invited" ? this._buildPendingIndicator() : this._buildConnectButton(name));
    }
    if (canManage) {
      actions.appendChild(this._buildRoleToggle(isAdmin));
      actions.appendChild(this._buildKickButton(name));
    }

    this._rootEl.replaceChildren(h("div", {
      className: "flex items-center gap-space-sm py-2 border-b border-outline-variant/20 last:border-0",
      "data-member-id": memberId,
    }, [
      h("div", {
        className: "w-8 h-8 rounded-lg flex items-center justify-center text-on-surface text-label-micro font-label-technical font-bold shrink-0",
        style: { background: "hsla(" + avatarHue(memberId) + ",55%,30%,0.9)" },
      }, avatarInitials(name)),
      h("div", { className: "flex flex-col flex-1 min-w-0" }, [
        h("p", { className: "text-body-sm font-body-sm text-on-surface font-bold truncate" }, name),
        h("p", { className: "text-label-micro font-label-technical text-on-surface-variant/60 truncate" }, ellipsisId(memberId, 20)),
      ]),
      isAdmin
        ? h("span", { className: "text-label-micro font-label-technical text-primary uppercase border border-primary/30 rounded px-space-sm py-0.5" }, "admin")
        : h("span", { className: "text-label-micro font-label-technical text-on-surface-variant/60 uppercase" }, "member"),
      actions,
    ]));
  }

  _buildConnectButton(name) {
    const groupId = this.#groupId;
    const memberId = this.#memberId;
    const btn = h("button", {
      type: "button",
      className: ACTION_BTN_CLASS,
      title: "Connect",
      "aria-label": "Connect with " + name,
    }, [materialIcon("person_add", { size: 16 })]);
    btn.addEventListener("click", (evt) => {
      evt.stopPropagation();
      btn.disabled = true;
      this.bus.call("contacts", "requestConnect", { peerAccountId: memberId, groupId }).catch((err) => {
        btn.disabled = false;
        console.error("[GroupMemberRowView] connect request failed", err);
        this.bus.emit("app.error", { source: "GroupMemberRowView", message: "connect request failed", severity: "warn", err });
      });
    });
    return btn;
  }

  _buildPendingIndicator() {
    return h("span", {
      className: "text-label-micro font-label-technical text-on-surface-variant/60 uppercase flex items-center gap-1",
      title: "Connection request pending",
    }, [materialIcon("hourglass_empty", { size: 14 }), "Requested"]);
  }

  _buildRoleToggle(isAdmin) {
    const groupId = this.#groupId;
    const memberId = this.#memberId;
    const nextRole = isAdmin ? "member" : "admin";
    const btn = h("button", {
      type: "button",
      className: ACTION_BTN_CLASS,
      title: isAdmin ? "Demote to member" : "Promote to admin",
      "aria-label": isAdmin ? "Demote to member" : "Promote to admin",
    }, [materialIcon(isAdmin ? "shield" : "workspace_premium", { size: 16 })]);
    btn.addEventListener("click", (evt) => {
      evt.stopPropagation();
      this.bus.call("groups", "setRole", { groupId, accountId: memberId, role: nextRole }).catch((err) => {
        console.error("[GroupMemberRowView] set role failed", err);
        this.bus.emit("app.error", { source: "GroupMemberRowView", message: "set role failed", severity: "warn", err });
      });
    });
    return btn;
  }

  _buildKickButton(name) {
    const groupId = this.#groupId;
    const memberId = this.#memberId;
    const btn = h("button", {
      type: "button",
      className: ACTION_BTN_DANGER_CLASS,
      title: "Kick member",
      "aria-label": "Kick member",
    }, [materialIcon("person_remove", { size: 16 })]);
    btn.addEventListener("click", (evt) => {
      evt.stopPropagation();
      const modal = new ConfirmModalView({
        bus: this.bus,
        title: "Kick member",
        message: "Are you sure you want to kick \"" + name + "\" from the group?",
        confirmLabel: "Kick",
        variant: "danger",
        onConfirm: () => {
          this.bus.call("groups", "kick", { groupId, accountId: memberId }).catch((err) => {
            console.error("[GroupMemberRowView] kick failed", err);
            this.bus.emit("app.error", { source: "GroupMemberRowView", message: "kick failed", severity: "warn", err });
          });
        },
      });
      modal.open();
    });
    return btn;
  }
}
