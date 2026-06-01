import { h } from "@rezprotocol/ui";
import { BusComponent } from "../base/BusComponent.js";
import { materialIcon } from "../base/icon.js";
import { OwnAvatarView } from "./OwnAvatarView.js";
import { UserMenuPopoverView } from "./UserMenuPopoverView.js";

// Phones-only bottom bar (lg:hidden). Three slots: Chats, Contacts, Avatar.
// The Avatar slot opens the same UserMenuPopoverView used by the desktop
// rail, so Profile / System / Disconnect live in one place.
export class MobileBottomBarView extends BusComponent {
  #ownAvatarView;
  #userMenu;
  #avatarSlot;
  #avatarBtnEl;
  #navEl;

  constructor({ bus } = {}) {
    super({ bus });
    this.#ownAvatarView = null;
    this.#userMenu = null;
    this.#avatarSlot = null;
    this.#avatarBtnEl = null;
    this.#navEl = null;
  }

  mount(parentEl) {
    super.mount(parentEl);
    if (!this._rootEl) return;
    this.#userMenu = new UserMenuPopoverView({ bus: this.bus });
    const stores = this.bus.stores;
    this._subscribe(stores.uiState, (evt) => {
      if (evt && evt.type === "ui.activeTab.changed") this.#refreshHighlight();
    });
    this._subscribe(stores.threads, () => this.#refreshChatBadge());
    this.render();
  }

  render() {
    if (!this._rootEl) return;
    const sessionStore = this.bus.stores.session;
    const accountLabel = sessionStore.selfLabel() || "Account";
    const accountId = sessionStore.selectedOrVaultAccountId() || "";

    this.#avatarSlot = h("div", { className: "w-6 h-6 rounded-full overflow-hidden" });
    if (this.#ownAvatarView) this.#ownAvatarView.unmount();
    this.#ownAvatarView = new OwnAvatarView({
      bus: this.bus, accountId, label: accountLabel,
      sizeClass: "w-full h-full", roundedClass: "rounded-full",
    });

    const chatsBtn = this.#buildTabButton("chat", "chat", "Chats", "mobileNav.chat");
    const contactsBtn = this.#buildTabButton("contacts", "contacts", "Contacts", "mobileNav.contacts");

    this.#avatarBtnEl = h("button", {
      type: "button",
      className: "flex-1 h-full flex flex-col items-center justify-center gap-1 text-on-surface-variant hover:text-primary transition-colors",
      "data-role": "user-menu-trigger",
      "data-testid": "mobileNav.userMenu",
      title: "Account menu",
      "aria-haspopup": "menu",
    }, [
      this.#avatarSlot,
      h("span", { className: "text-label-micro font-label-technical tracking-[0.1em]" }, "ME"),
    ]);
    this.#avatarBtnEl.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (this.#userMenu) this.#userMenu.toggle(this.#avatarBtnEl);
    });

    this.#navEl = h("div", {
      className: "flex h-full items-stretch justify-around",
    }, [chatsBtn, contactsBtn, this.#avatarBtnEl]);

    this._rootEl.replaceChildren(this.#navEl);
    this.#ownAvatarView.mount(this.#avatarSlot);
    this.#refreshChatBadge();
  }

  #buildTabButton(id, iconName, label, testId) {
    const active = this.#getActiveTab() === id;
    const badgeSlot = h("div", {
      className: "absolute top-1.5 right-[calc(50%-18px)]",
      "data-role": "mobile-nav-badge-slot",
    });
    const button = h("button", {
      type: "button",
      className: active
        ? "flex-1 h-full flex flex-col items-center justify-center gap-1 text-primary relative"
        : "flex-1 h-full flex flex-col items-center justify-center gap-1 text-on-surface-variant hover:text-primary transition-colors relative",
      "data-testid": testId,
      "data-nav-id": id,
      "data-nav-icon": iconName,
    }, [
      materialIcon(iconName, { weight: active ? "fill" : "regular", size: 22 }),
      h("span", { className: "text-label-micro font-label-technical tracking-[0.1em] " + (active ? "font-bold" : "") }, label.toUpperCase()),
      badgeSlot,
    ]);
    button.addEventListener("click", () => {
      this.bus.call("ui", "navigateTab", { to: id }).catch((err) => {
        console.error("[MobileBottomBarView] navigate to " + id + " failed", err);
        this.bus.emit("app.error", { source: "MobileBottomBarView", message: "navigate to " + id + " failed", severity: "warn", err });
      });
    });
    return button;
  }

  #refreshHighlight() {
    if (!this.#navEl) return;
    const activeTab = this.#getActiveTab();
    const buttons = this.#navEl.querySelectorAll("[data-nav-id]");
    for (const btn of buttons) {
      const id = btn.getAttribute("data-nav-id");
      const active = id === activeTab;
      btn.className = active
        ? "flex-1 h-full flex flex-col items-center justify-center gap-1 text-primary relative"
        : "flex-1 h-full flex flex-col items-center justify-center gap-1 text-on-surface-variant hover:text-primary transition-colors relative";
      const iconName = btn.getAttribute("data-nav-icon");
      const oldIconEl = btn.querySelector("span.material-symbols-outlined");
      if (iconName && oldIconEl) {
        oldIconEl.replaceWith(materialIcon(iconName, { weight: active ? "fill" : "regular", size: 22 }));
      }
      const labelEl = btn.querySelector("span:not(.material-symbols-outlined):not([data-role])");
      if (labelEl) {
        labelEl.className = "text-label-micro font-label-technical tracking-[0.1em] " + (active ? "font-bold" : "");
      }
    }
  }

  #refreshChatBadge() {
    if (!this.#navEl) return;
    const chatBtn = this.#navEl.querySelector("[data-nav-id='chat']");
    if (!chatBtn) return;
    const slot = chatBtn.querySelector("[data-role='mobile-nav-badge-slot']");
    if (!slot) return;
    const threads = this.bus.stores.threads.getThreads();
    let total = 0;
    for (const thread of threads) {
      const count = Number(thread && thread.unreadCount || 0);
      if (count > 0) total += count;
    }
    if (total <= 0) {
      slot.replaceChildren();
      return;
    }
    slot.replaceChildren(h("div", {
      className: "w-2 h-2 rounded-full bg-primary status-glow-cyan",
      "aria-label": total + " unread",
    }));
  }

  #getActiveTab() {
    return this.bus.stores.uiState.activeTab();
  }

  unmount() {
    if (this.#userMenu) { this.#userMenu.close(); this.#userMenu = null; }
    if (this.#ownAvatarView) { this.#ownAvatarView.unmount(); this.#ownAvatarView = null; }
    this.#avatarBtnEl = null;
    this.#avatarSlot = null;
    this.#navEl = null;
    super.unmount();
  }
}
