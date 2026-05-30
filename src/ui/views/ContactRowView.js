import { h } from "rez-ui";
import { BusComponent } from "../base/BusComponent.js";
import { materialIcon } from "../base/icon.js";
import { ellipsisId, avatarInitials, avatarHue } from "../presenters/labels.js";
import { ConfirmModalView } from "./ConfirmModalView.js";

const ROW_BASE_CLASS = "relative group/contact w-full text-left flex items-center gap-space-md px-space-lg min-h-[64px] py-space-sm transition-colors border-b border-outline-variant/20 hover:bg-surface-container/60";
const ACTION_WRAP_CLASS = "absolute right-2 top-1/2 -translate-y-1/2 opacity-0 group-hover/contact:opacity-100 transition-opacity flex items-center gap-1 bg-surface-container-high/90 backdrop-blur-sm rounded-md p-0.5 border border-outline-variant/20";

function actionBtnClass({ danger = false, active = false } = {}) {
  if (active) {
    return "w-7 h-7 flex items-center justify-center rounded text-error bg-error/10 transition-colors";
  }
  if (danger) {
    return "w-7 h-7 flex items-center justify-center rounded text-on-surface-variant hover:text-error hover:bg-error/10 transition-colors";
  }
  return "w-7 h-7 flex items-center justify-center rounded text-on-surface-variant hover:text-primary hover:bg-primary/10 transition-colors";
}

export class ContactRowView extends BusComponent {
  #accountId;
  #renaming;

  constructor({ bus, accountId } = {}) {
    super({ bus });
    this.#accountId = String(accountId || "").trim();
    if (!this.#accountId) throw new Error("ContactRowView requires accountId");
    this.#renaming = false;
  }

  get accountId() {
    return this.#accountId;
  }

  mount(parentEl) {
    super.mount(parentEl);
    if (!this._rootEl) return;
    const stores = this.bus.stores || {};
    if (stores.contacts) {
      this._subscribe(stores.contacts, (evt) => {
        const type = evt && typeof evt.type === "string" ? evt.type : "";
        const keys = evt && evt.keys ? evt.keys : {};
        if ((type === "contacts.upserted" || type === "contacts.removed")
            && keys.accountId !== this.#accountId) return;
        if (this.#renaming) return;
        this.render();
      });
    }
    this.render();
  }

  render() {
    if (!this._rootEl) return;
    const stores = this.bus.stores || {};
    const contact = stores.contacts ? stores.contacts.getContact(this.#accountId) : null;
    if (!contact) {
      this._rootEl.replaceChildren();
      return;
    }
    const accountId = this.#accountId;
    const label = String(contact.displayName || accountId).trim() || "Unknown";
    const isBlocked = String(contact.relationshipState || "active").trim().toLowerCase() === "blocked";

    const nameClass = (isBlocked ? "text-on-surface-variant/60" : "text-on-surface")
      + " text-body-base font-bold truncate font-body-base";

    const el = h("div", {
      className: ROW_BASE_CLASS,
    }, [
      h("div", {
        className: "relative w-10 h-10 rounded-lg flex items-center justify-center text-on-surface text-label-micro font-label-technical font-bold shrink-0",
        style: { background: "hsla(" + avatarHue(accountId) + ",55%,30%,0.9)" },
      }, [
        document.createTextNode(avatarInitials(label)),
        isBlocked ? h("div", { className: "absolute -top-1 -right-1 w-4 h-4 bg-surface-container-lowest/90 rounded-full flex items-center justify-center" }, [
          h("span", { className: "material-symbols-outlined text-error", style: { fontSize: "10px" } }, "block"),
        ]) : null,
      ]),
      h("div", { className: "flex flex-col flex-1 min-w-0" }, [
        h("p", { className: nameClass, "data-role": "contact-name" }, label),
        h("p", { className: "text-on-surface-variant/60 text-label-micro font-label-technical truncate mt-0.5" }, ellipsisId(accountId, 20)),
      ]),
      this._buildActions(accountId, label, isBlocked),
    ]);

    this._rootEl.replaceChildren(el);
  }

  _buildActions(accountId, label, isBlocked) {
    const actions = h("div", { className: ACTION_WRAP_CLASS });

    const msgBtn = h("button", {
      type: "button",
      className: actionBtnClass(),
      title: "Send message",
      "aria-label": "Send message",
      "data-thread-action": "message",
    }, [materialIcon("chat", { size: 16 })]);
    msgBtn.addEventListener("click", (evt) => {
      evt.stopPropagation();
      msgBtn.disabled = true;
      this.bus.call("threads", "createDirect", { accountId: accountId }).then(() => {
        return this.bus.call("ui", "navigateTab", { to: "chat" });
      }).catch((err) => {
        console.error("[ContactRowView] create direct thread failed", err);
        this.bus.emit("app.error", { source: "ContactRowView", message: "create direct thread failed", severity: "warn", err });
      }).finally(() => { msgBtn.disabled = false; });
    });

    const renameBtn = h("button", {
      type: "button",
      className: actionBtnClass(),
      title: "Rename",
      "aria-label": "Rename",
      "data-thread-action": "rename",
    }, [materialIcon("edit", { size: 16 })]);
    renameBtn.addEventListener("click", (evt) => {
      evt.stopPropagation();
      this._startInlineRename(label, isBlocked);
    });

    const blockBtn = h("button", {
      type: "button",
      className: actionBtnClass({ active: isBlocked }),
      title: isBlocked ? "Unblock" : "Block",
      "aria-label": isBlocked ? "Unblock" : "Block",
      "data-thread-action": "block",
    }, [materialIcon("block", { size: 16 })]);
    blockBtn.addEventListener("click", (evt) => {
      evt.stopPropagation();
      const method = isBlocked ? "unblock" : "block";
      this.bus.call("contacts", method, { accountId: accountId }).catch((err) => {
        console.error("[ContactRowView] contact " + method + " failed", err);
        this.bus.emit("app.error", { source: "ContactRowView", message: "contact " + method + " failed", severity: "warn", err });
      });
    });

    const delBtn = h("button", {
      type: "button",
      className: actionBtnClass({ danger: true }),
      title: "Delete",
      "aria-label": "Delete",
      "data-thread-action": "delete",
    }, [materialIcon("delete", { size: 16 })]);
    delBtn.addEventListener("click", (evt) => {
      evt.stopPropagation();
      const modal = new ConfirmModalView({
        bus: this.bus,
        title: "Delete contact",
        message: "Are you sure you want to delete \"" + label + "\"? This cannot be undone.",
        confirmLabel: "Delete",
        variant: "danger",
        onConfirm: () => {
          this.bus.call("contacts", "delete", { accountId: accountId }).catch((err) => {
            console.error("[ContactRowView] contact delete failed", err);
            this.bus.emit("app.error", { source: "ContactRowView", message: "contact delete failed", severity: "warn", err });
          });
        },
      });
      modal.open();
    });

    actions.appendChild(msgBtn);
    actions.appendChild(renameBtn);
    actions.appendChild(blockBtn);
    actions.appendChild(delBtn);
    return actions;
  }

  _startInlineRename(currentName, isBlocked) {
    if (!this._rootEl) return;
    const nameEl = this._rootEl.querySelector("[data-role='contact-name']");
    if (!nameEl) return;
    const accountId = this.#accountId;
    const cls = (isBlocked ? "text-on-surface-variant/60" : "text-on-surface")
      + " text-body-base font-bold truncate font-body-base";
    const input = h("input", {
      type: "text", value: currentName,
      className: "bg-surface-container-high border border-primary/60 rounded px-2 py-0.5 text-body-base font-body-base text-on-surface outline-none w-full",
      "data-thread-action": "rename-input",
    });
    input.addEventListener("click", (evt) => evt.stopPropagation());
    input.addEventListener("mousedown", (evt) => evt.stopPropagation());
    nameEl.replaceWith(input);
    this.#renaming = true;
    input.focus();
    input.select();
    const finish = () => {
      this.#renaming = false;
    };
    const commit = () => {
      finish();
      const newName = String(input.value || "").trim();
      const restored = h("p", { className: cls, "data-role": "contact-name" }, newName || currentName);
      if (input.isConnected) input.replaceWith(restored);
      if (newName && newName !== currentName) {
        this.bus.call("contacts", "rename", { accountId: accountId, displayName: newName }).catch((err) => {
          console.error("[ContactRowView] contact rename failed", err);
          this.bus.emit("app.error", { source: "ContactRowView", message: "contact rename failed", severity: "warn", err });
          restored.textContent = currentName;
        });
      }
    };
    const cancel = () => {
      finish();
      if (input.isConnected) {
        input.replaceWith(h("p", { className: cls, "data-role": "contact-name" }, currentName));
      }
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); commit(); }
      if (e.key === "Escape") { e.preventDefault(); cancel(); }
    });
    input.addEventListener("blur", commit);
  }
}
