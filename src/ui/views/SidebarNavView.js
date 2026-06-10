import { h } from "@rezprotocol/ui";
import { BusComponent } from "../base/BusComponent.js";
import { materialIcon } from "../base/icon.js";
import { OwnAvatarView } from "./OwnAvatarView.js";
import { UserMenuPopoverView } from "./UserMenuPopoverView.js";
import { SESSION_STATUS } from "../stores/SessionStore.js";

const REZ_LOGO_URL = new URL(
  "../../../../rez-ui/branding/filled-silhouette/rez-icon-full-transparent-filled.png",
  import.meta.url,
).href;

const NAV_ITEMS = [
  { id: "chat", icon: "chat", testId: "nav.chat" },
  { id: "contacts", icon: "contacts", testId: "nav.contacts" },
];

function hasReachableSeed(seedReachable) {
  if (!seedReachable || typeof seedReachable !== "object") return false;
  return Object.values(seedReachable).some((value) => value === true);
}

function buildStatusModel(connection, authStatus) {
  const status = connection && connection.status ? connection.status : "idle";
  const mesh = connection && connection.mesh && typeof connection.mesh === "object" ? connection.mesh : {};
  const peerCount = Number(mesh.peerCount || 0);
  const routable = peerCount > 0 || hasReachableSeed(mesh.seedReachable);
  const authSuffix = authStatus === SESSION_STATUS.UNLOCKED ? "" : " · " + String(authStatus).toLowerCase();
  if (status === "connected" && routable) {
    return { tone: "connected", title: "Connected · Reznet routable" + authSuffix };
  }
  if (status === "connected") {
    return { tone: "connected-local", title: "Connected · Reznet local only" + authSuffix };
  }
  if (status === "connecting") {
    return { tone: "connecting", title: "Connecting…" + authSuffix };
  }
  return { tone: "offline", title: "Offline" + authSuffix };
}

function dotColorForTone(tone) {
  if (tone === "connected") return "bg-green-500 shadow-[0_0_6px_rgba(34,197,94,0.7)]";
  if (tone === "connected-local") return "bg-amber-400 shadow-[0_0_6px_rgba(251,191,36,0.7)]";
  if (tone === "connecting") return "bg-amber-400 shadow-[0_0_6px_rgba(251,191,36,0.7)]";
  return "bg-red-500 shadow-[0_0_6px_rgba(239,68,68,0.7)]";
}

export class SidebarNavView extends BusComponent {
  #ownAvatarView;
  #userMenu;
  #avatarBtnEl;
  #avatarSlot;
  #statusDotEl;
  #navEl;

  constructor({ bus } = {}) {
    super({ bus });
    this.#ownAvatarView = null;
    this.#userMenu = null;
    this.#avatarBtnEl = null;
    this.#avatarSlot = null;
    this.#statusDotEl = null;
    this.#navEl = null;
  }

  mount(parentEl) {
    super.mount(parentEl);
    if (!this._rootEl) return;
    this.#userMenu = new UserMenuPopoverView({ bus: this.bus });
    const stores = this.bus.stores;
    this._subscribe(stores.uiState, (evt) => {
      if (evt && evt.type === "ui.activeTab.changed") this.#refreshNavHighlight();
    });
    this._subscribe(stores.threads, () => this.#refreshChatUnreadBadge());
    if (stores.connectRequests) {
      this._subscribe(stores.connectRequests, () => this.#refreshContactsBadge());
    }
    this._subscribe(stores.connection, () => this.#refreshStatusIndicator());
    this._subscribe(stores.session, () => this.#refreshStatusIndicator());
    this.render();
  }

  render() {
    if (!this._rootEl) return;
    const sessionStore = this.bus.stores.session;
    const accountLabel = sessionStore.selfLabel() || "Account";
    const accountId = sessionStore.selectedOrVaultAccountId() || "";

    const wordmark = h("div", { className: "mb-space-xl titlebar-drag select-none flex items-center justify-center" }, [
      h("img", {
        src: REZ_LOGO_URL,
        alt: "Rez",
        className: "w-8 h-8 object-contain",
        draggable: "false",
      }),
    ]);

    this.#navEl = h("div", { className: "flex flex-col gap-8 items-center flex-1" }, NAV_ITEMS.map((item) => this.#buildNavButton(item)));

    this.#avatarSlot = h("div", { className: "absolute inset-0 rounded-full overflow-hidden" });
    if (this.#ownAvatarView) this.#ownAvatarView.unmount();
    this.#ownAvatarView = new OwnAvatarView({
      bus: this.bus, accountId, label: accountLabel,
      sizeClass: "w-full h-full", roundedClass: "rounded-full",
    });
    this.#statusDotEl = h("span", {
      className: "absolute bottom-0 right-0 w-3 h-3 rounded-full border-2 border-surface-dim bg-red-500 shadow-[0_0_6px_rgba(239,68,68,0.7)] pointer-events-none",
      "data-role": "connection-status-dot",
      "data-tone": "offline",
    });
    this.#avatarBtnEl = h("button", {
      type: "button",
      className: "relative w-10 h-10 rounded-full ring-2 ring-primary/30 hover:ring-primary/60 transition-all",
      "data-role": "user-menu-trigger",
      "data-testid": "nav.userMenu",
      title: accountLabel || "Account menu",
      "aria-haspopup": "menu",
      "aria-label": accountLabel || "Account menu",
    }, [this.#avatarSlot, this.#statusDotEl]);
    this.#avatarBtnEl.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (this.#userMenu) this.#userMenu.toggle(this.#avatarBtnEl);
    });

    const bottom = h("div", { className: "mt-auto pb-space-lg" }, [this.#avatarBtnEl]);

    const rail = h("nav", {
      className: "titlebar-rail-inset flex flex-col items-center py-space-lg gap-space-xl w-sidebar-width h-full border-r border-outline-variant/30 backdrop-blur-xl bg-surface-dim/80",
    }, [wordmark, this.#navEl, bottom]);

    this._rootEl.replaceChildren(rail);

    this.#ownAvatarView.mount(this.#avatarSlot);

    this.#refreshChatUnreadBadge();
    this.#refreshContactsBadge();
    this.#refreshStatusIndicator();
  }

  #buildNavButton(item) {
    const active = this.#getActiveTab() === item.id;
    const badgeSlot = h("span", {
      className: "absolute top-1 right-1",
      "data-role": "nav-badge-slot",
    });
    const button = h("button", {
      type: "button",
      className: active
        ? "relative w-10 h-10 rounded-xl flex items-center justify-center text-primary bg-primary/10 border border-primary/20 shadow-[0_0_15px_rgba(1,218,243,0.1)]"
        : "relative w-10 h-10 rounded-xl flex items-center justify-center text-on-surface-variant hover:text-primary hover:bg-primary/5 transition-all",
      "data-testid": item.testId,
      "data-nav-id": item.id,
      "data-nav-icon": item.icon,
      title: item.id.charAt(0).toUpperCase() + item.id.slice(1),
      "aria-label": item.id,
    }, [
      materialIcon(item.icon, { weight: active ? "fill" : "regular" }),
      badgeSlot,
    ]);
    button.addEventListener("click", () => {
      this.bus.call("ui", "navigateTab", { to: item.id }).catch((err) => {
        console.error("[SidebarNavView] navigate to " + item.id + " failed", err);
        this.bus.emit("app.error", { source: "SidebarNavView", message: "navigate to " + item.id + " failed", severity: "warn", err });
      });
    });
    return button;
  }

  #refreshNavHighlight() {
    if (!this.#navEl) return;
    const activeTab = this.#getActiveTab();
    const buttons = this.#navEl.querySelectorAll("[data-nav-id]");
    for (const btn of buttons) {
      const id = btn.getAttribute("data-nav-id");
      const iconName = btn.getAttribute("data-nav-icon");
      const active = id === activeTab;
      btn.className = active
        ? "relative w-10 h-10 rounded-xl flex items-center justify-center text-primary bg-primary/10 border border-primary/20 shadow-[0_0_15px_rgba(1,218,243,0.1)]"
        : "relative w-10 h-10 rounded-xl flex items-center justify-center text-on-surface-variant hover:text-primary hover:bg-primary/5 transition-all";
      const oldIconEl = btn.querySelector("span.material-symbols-outlined");
      if (iconName && oldIconEl) {
        oldIconEl.replaceWith(materialIcon(iconName, { weight: active ? "fill" : "regular" }));
      }
    }
  }

  #refreshChatUnreadBadge() {
    if (!this.#navEl) return;
    const chatBtn = this.#navEl.querySelector("[data-nav-id='chat']");
    if (!chatBtn) return;
    const slot = chatBtn.querySelector("[data-role='nav-badge-slot']");
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
    slot.replaceChildren(h("span", {
      className: "block w-2 h-2 rounded-full bg-primary status-glow-cyan",
      "data-role": "nav-badge",
      "aria-label": total + " unread",
    }));
  }

  #refreshContactsBadge() {
    if (!this.#navEl) return;
    const contactsBtn = this.#navEl.querySelector("[data-nav-id='contacts']");
    if (!contactsBtn) return;
    const slot = contactsBtn.querySelector("[data-role='nav-badge-slot']");
    if (!slot) return;
    const queries = this.bus.queries;
    const count = queries && queries.contacts && typeof queries.contacts.incomingConnectRequestCount === "function"
      ? queries.contacts.incomingConnectRequestCount() : 0;
    if (count <= 0) {
      slot.replaceChildren();
      return;
    }
    slot.replaceChildren(h("span", {
      className: "flex items-center justify-center min-w-4 h-4 px-1 rounded-full bg-primary text-on-primary text-[10px] font-bold leading-none status-glow-cyan",
      "data-role": "nav-badge",
      "aria-label": count + " pending connection request" + (count === 1 ? "" : "s"),
    }, String(count > 9 ? "9+" : count)));
  }

  #refreshStatusIndicator() {
    if (!this.#avatarBtnEl || !this.#statusDotEl) return;
    const stores = this.bus.stores;
    const connection = stores.connection.getConnection();
    const accountLabel = stores.session.selfLabel();
    const authStatus = stores.session.status();
    const model = buildStatusModel(connection, authStatus);
    this.#statusDotEl.className = "absolute bottom-0 right-0 w-3 h-3 rounded-full border-2 border-surface-dim pointer-events-none " + dotColorForTone(model.tone);
    this.#statusDotEl.setAttribute("data-tone", model.tone);
    const title = (accountLabel ? accountLabel + " — " : "") + model.title;
    this.#avatarBtnEl.setAttribute("title", title);
    this.#avatarBtnEl.setAttribute("aria-label", title);
  }

  #getActiveTab() {
    return this.bus.stores.uiState.activeTab();
  }

  unmount() {
    if (this.#userMenu) { this.#userMenu.close(); this.#userMenu = null; }
    if (this.#ownAvatarView) { this.#ownAvatarView.unmount(); this.#ownAvatarView = null; }
    this.#avatarBtnEl = null;
    this.#avatarSlot = null;
    this.#statusDotEl = null;
    this.#navEl = null;
    super.unmount();
  }
}
