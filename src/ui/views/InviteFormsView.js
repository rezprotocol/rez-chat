import { h } from "rez-ui";
import { BusComponent } from "../base/BusComponent.js";

const CARD_CLASS = "rounded-lg border border-outline-variant/30 bg-surface-container-low p-space-lg flex flex-col gap-space-md";
const HEADING_CLASS = "text-headline-sm font-headline-sm text-on-surface";
const HELP_CLASS = "text-body-sm font-body-sm text-on-surface-variant/70";
const INPUT_CLASS = "flex-1 bg-surface-container border border-outline-variant/40 rounded-lg px-space-md py-2.5 font-label-technical text-label-technical text-on-surface placeholder:text-outline-variant focus:border-primary/60 focus:ring-1 focus:ring-primary/30 focus:outline-none transition-all";
const PRIMARY_BTN_CLASS = "bg-primary-container text-on-primary-container font-label-technical text-label-technical font-bold px-space-lg py-2.5 rounded-lg hover:bg-primary hover:text-on-primary transition-all cursor-pointer shrink-0 disabled:opacity-50 disabled:cursor-not-allowed";
const GHOST_BTN_CLASS = "bg-surface-container border border-outline-variant/40 text-on-surface-variant font-label-technical text-label-technical font-bold px-space-lg py-2.5 rounded-lg hover:border-primary/40 hover:text-primary hover:bg-surface-container-high transition-all cursor-pointer self-start disabled:opacity-50 disabled:cursor-not-allowed";
const ERROR_CLASS = "hidden text-label-micro font-label-technical text-error mt-1";
const SUCCESS_CLASS = "hidden text-label-micro font-label-technical text-primary mt-1";

export class InviteFormsView extends BusComponent {
  mount(parentEl) {
    super.mount(parentEl);
    if (!this._rootEl) return;
    const inviteStore = this.bus.stores.invites;
    if (inviteStore && typeof inviteStore.onChange === "function") {
      this._subscribe(inviteStore, (evt) => {
        const type = evt && typeof evt.type === "string" ? evt.type : "";
        if (type === "invites.lastCreatedInviteCodeChanged") {
          this._refreshInviteCode();
        }
      });
    }
    this.render();
  }

  render() {
    if (!this._rootEl) return;
    const content = h("div", {
      className: "p-space-lg md:p-space-xl flex flex-col gap-space-lg max-w-2xl overflow-y-auto custom-scrollbar h-full",
    }, []);

    content.appendChild(this._buildAcceptSection());
    content.appendChild(this._buildDirectSection());
    content.appendChild(this._buildGroupSection());

    this._inviteCodeSlot = h("div", {}, []);
    content.appendChild(this._inviteCodeSlot);
    this._refreshInviteCode();

    content.appendChild(this._buildRefreshSection());

    this._rootEl.replaceChildren(content);
  }

  _buildAcceptSection() {
    const acceptInput = h("input", {
      type: "text",
      placeholder: "Paste invite code...",
      className: INPUT_CLASS,
      "data-testid": "invite.accept.input",
    });
    const acceptError = h("p", { className: ERROR_CLASS, "data-testid": "invite.accept.error" }, "");
    const acceptSuccess = h("p", { className: SUCCESS_CLASS, "data-testid": "invite.accept.success" }, "");
    const acceptBtn = h("button", {
      type: "button",
      className: PRIMARY_BTN_CLASS,
      "data-testid": "invite.accept.button",
    }, "Accept");

    const doAccept = () => {
      const code = String(acceptInput.value || "").trim();
      if (!code) {
        acceptError.textContent = "Paste an invite code first.";
        acceptError.classList.remove("hidden");
        acceptSuccess.classList.add("hidden");
        return;
      }
      acceptBtn.disabled = true;
      acceptBtn.textContent = "Accepting...";
      acceptError.classList.add("hidden");
      acceptSuccess.classList.add("hidden");
      this.bus.call("invites", "accept", { inviteCode: code }).then(() => {
        acceptInput.value = "";
        acceptSuccess.textContent = "Invite accepted.";
        acceptSuccess.classList.remove("hidden");
        acceptError.classList.add("hidden");
        this.bus.call("ui", "navigateTab", { to: "chat" }).catch((err) => {
          console.error("[InviteFormsView] navigate to chat failed", err);
          this.bus.emit("app.error", { source: "InviteFormsView", message: "navigate to chat failed", severity: "warn", err });
        });
      }).catch((err) => {
        acceptError.textContent = err && err.message ? err.message : "Failed to accept invite.";
        acceptError.classList.remove("hidden");
        acceptSuccess.classList.add("hidden");
      }).finally(() => {
        acceptBtn.disabled = false;
        acceptBtn.textContent = "Accept";
      });
    };
    acceptBtn.addEventListener("click", doAccept);
    acceptInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        doAccept();
      }
    });

    return h("section", { className: CARD_CLASS }, [
      h("h3", { className: HEADING_CLASS }, "Accept Invite"),
      h("p", { className: HELP_CLASS }, "Paste an invite code from a friend to connect."),
      h("div", { className: "flex gap-space-sm items-center" }, [acceptInput, acceptBtn]),
      acceptError,
      acceptSuccess,
    ]);
  }

  _buildDirectSection() {
    const directError = h("p", { className: ERROR_CLASS }, "");
    const directBtn = h("button", {
      type: "button",
      className: PRIMARY_BTN_CLASS,
      "data-testid": "invite.create.direct.button",
    }, "Generate invite code");

    directBtn.addEventListener("click", () => {
      directBtn.disabled = true;
      directBtn.textContent = "Creating...";
      directError.classList.add("hidden");
      this.bus.call("invites", "createDirect", {}).catch((err) => {
        console.error("[InviteFormsView] create direct invite failed", err);
        directError.textContent = err && err.message ? err.message : "Failed to create invite.";
        directError.classList.remove("hidden");
        this.bus.emit("app.error", { source: "InviteFormsView", message: "create direct invite failed", severity: "warn", err });
      }).finally(() => {
        directBtn.disabled = false;
        directBtn.textContent = "Generate invite code";
      });
    });

    return h("section", { className: CARD_CLASS }, [
      h("h3", { className: HEADING_CLASS }, "Direct Invite"),
      h("p", { className: HELP_CLASS }, "Create a one-time invite code to add a contact."),
      h("div", { className: "flex gap-space-md items-center" }, [directBtn]),
      directError,
    ]);
  }

  _buildGroupSection() {
    const groupNameInput = h("input", {
      type: "text",
      placeholder: "Group name...",
      className: INPUT_CLASS,
    });
    const groupError = h("p", { className: ERROR_CLASS }, "");
    const groupBtn = h("button", {
      type: "button",
      className: PRIMARY_BTN_CLASS,
    }, "Create group");

    groupBtn.addEventListener("click", () => {
      const title = String(groupNameInput.value || "").trim();
      if (!title) {
        groupError.textContent = "Enter a group name first.";
        groupError.classList.remove("hidden");
        groupNameInput.focus();
        return;
      }
      groupBtn.disabled = true;
      groupBtn.textContent = "Creating...";
      groupError.classList.add("hidden");
      this.bus.call("invites", "createGroup", { title }).then(() => {
        groupNameInput.value = "";
      }).catch((err) => {
        console.error("[InviteFormsView] create group invite failed", err);
        groupError.textContent = err && err.message ? err.message : "Failed to create group invite.";
        groupError.classList.remove("hidden");
        this.bus.emit("app.error", { source: "InviteFormsView", message: "create group invite failed", severity: "warn", err });
      }).finally(() => {
        groupBtn.disabled = false;
        groupBtn.textContent = "Create group";
      });
    });
    groupNameInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        groupBtn.click();
      }
    });

    return h("section", { className: CARD_CLASS }, [
      h("h3", { className: HEADING_CLASS }, "Group Invite"),
      h("p", { className: HELP_CLASS }, "Create a new group and generate an invite code for it."),
      h("div", { className: "flex gap-space-sm items-center" }, [groupNameInput, groupBtn]),
      groupError,
    ]);
  }

  _refreshInviteCode() {
    if (!this._inviteCodeSlot) return;
    const inviteStore = this.bus.stores.invites;
    const code = inviteStore && typeof inviteStore.getLastCreatedInviteCode === "function"
      ? String(inviteStore.getLastCreatedInviteCode() || "").trim()
      : "";
    if (!code) {
      this._inviteCodeSlot.replaceChildren();
      return;
    }
    this._inviteCodeSlot.replaceChildren(
      h("section", { className: "rounded-lg border border-primary/30 bg-primary/5 p-space-md flex flex-col gap-space-sm" }, [
        h("span", { className: "text-label-micro font-label-technical text-primary/70 uppercase tracking-wider" }, "Last invite code"),
        h("p", {
          className: "font-label-technical text-label-technical text-primary break-all bg-surface-container-lowest border border-primary/30 rounded px-space-md py-2.5 select-all",
          "data-testid": "invite.lastCreated.code",
        }, code),
      ]),
    );
  }

  _buildRefreshSection() {
    const refreshBtn = h("button", {
      type: "button",
      className: GHOST_BTN_CLASS,
    }, "Refresh contacts & groups");
    refreshBtn.addEventListener("click", () => {
      refreshBtn.disabled = true;
      refreshBtn.textContent = "Refreshing...";
      Promise.all([
        this.bus.call("contacts", "ensureList", { force: true }),
        this.bus.call("groups", "ensureList", { force: true }),
      ]).catch((err) => {
        console.error("[InviteFormsView] contacts/groups refresh failed", err);
        this.bus.emit("app.error", { source: "InviteFormsView", message: "contacts/groups refresh failed", severity: "warn", err });
      }).finally(() => {
        refreshBtn.disabled = false;
        refreshBtn.textContent = "Refresh contacts & groups";
      });
    });
    return h("div", { className: "pt-space-md border-t border-outline-variant/30" }, [refreshBtn]);
  }

  unmount() {
    this._inviteCodeSlot = null;
    super.unmount();
  }
}
