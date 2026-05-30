import { h } from "rez-ui";
import { materialIcon } from "../base/icon.js";

// Floating popover anchored to a trigger element. Mounted into document.body
// on open(); positioned just above the anchor (flipping below if there isn't
// room). Closes on outside-click, Escape, or any navigation.
//
// Not a BusComponent because it has no fixed parentEl — it owns its own DOM
// lifecycle and is opened on demand by whichever view holds its instance
// (SidebarNavView on desktop, MobileBottomBarView on phones).
export class UserMenuPopoverView {
  #bus;
  #panel;
  #anchorEl;
  #onDocMouseDown;
  #onKeydown;
  #onResize;
  #busOffs;

  constructor({ bus } = {}) {
    if (!bus || typeof bus !== "object") {
      throw new Error("UserMenuPopoverView requires bus");
    }
    this.#bus = bus;
    this.#panel = null;
    this.#anchorEl = null;
    this.#onDocMouseDown = null;
    this.#onKeydown = null;
    this.#onResize = null;
    this.#busOffs = [];
  }

  isOpen() {
    return this.#panel !== null;
  }

  toggle(anchorEl) {
    if (this.isOpen()) {
      this.close();
    } else {
      this.open(anchorEl);
    }
  }

  open(anchorEl) {
    if (this.isOpen()) return;
    if (!anchorEl || typeof anchorEl.getBoundingClientRect !== "function") return;
    this.#anchorEl = anchorEl;

    const items = [
      { kind: "item", label: "Profile", iconName: "account_circle", action: () => this.#go("profile") },
      { kind: "item", label: "System", iconName: "settings", action: () => this.#go("settings") },
      { kind: "divider" },
      { kind: "item", label: "Disconnect", iconName: "power_settings_new", danger: true, action: () => this.#disconnect() },
    ];

    const panel = h("div", {
      className: "fixed z-50 min-w-[200px] rounded-lg border border-outline-variant/30 bg-surface-container shadow-2xl p-1.5",
      "data-role": "user-menu-popover",
      role: "menu",
    }, items.map((item) => this.#buildItem(item)));

    document.body.appendChild(panel);
    this.#panel = panel;
    this.#position();

    this.#onDocMouseDown = (ev) => {
      if (!this.#panel) return;
      if (this.#panel.contains(ev.target)) return;
      if (this.#anchorEl && this.#anchorEl.contains(ev.target)) return;
      this.close();
    };
    document.addEventListener("mousedown", this.#onDocMouseDown, true);

    this.#onKeydown = (ev) => {
      if (ev.key === "Escape") this.close();
    };
    document.addEventListener("keydown", this.#onKeydown, true);

    this.#onResize = () => this.#position();
    window.addEventListener("resize", this.#onResize, true);

    const offTabChange = this.#bus.on("ui.activeTab.changed", () => this.close());
    if (typeof offTabChange === "function") this.#busOffs.push(offTabChange);
  }

  close() {
    if (!this.#panel) return;
    this.#panel.remove();
    this.#panel = null;
    this.#anchorEl = null;
    if (this.#onDocMouseDown) {
      document.removeEventListener("mousedown", this.#onDocMouseDown, true);
      this.#onDocMouseDown = null;
    }
    if (this.#onKeydown) {
      document.removeEventListener("keydown", this.#onKeydown, true);
      this.#onKeydown = null;
    }
    if (this.#onResize) {
      window.removeEventListener("resize", this.#onResize, true);
      this.#onResize = null;
    }
    for (const off of this.#busOffs.splice(0)) {
      try { off(); } catch (err) {
        console.error("[UserMenuPopoverView] bus unsubscribe failed", err);
      }
    }
  }

  #buildItem(item) {
    if (item.kind === "divider") {
      return h("div", { className: "my-1.5 h-px bg-outline-variant/30" });
    }
    const btn = h("button", {
      type: "button",
      role: "menuitem",
      className: item.danger
        ? "w-full flex items-center gap-space-sm px-space-md py-2 rounded text-label-technical font-label-technical text-error hover:bg-error/10 transition-colors"
        : "w-full flex items-center gap-space-sm px-space-md py-2 rounded text-label-technical font-label-technical text-on-surface-variant hover:text-primary hover:bg-surface-container-high transition-colors",
      "data-action": "user-menu." + item.label.toLowerCase(),
    }, [
      materialIcon(item.iconName, { size: 16 }),
      h("span", {}, item.label),
    ]);
    btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      item.action();
    });
    return btn;
  }

  #position() {
    if (!this.#panel || !this.#anchorEl) return;
    const margin = 8;
    const anchorRect = this.#anchorEl.getBoundingClientRect();
    const panelRect = this.#panel.getBoundingClientRect();
    let top = anchorRect.top - panelRect.height - margin;
    if (top < margin) top = anchorRect.bottom + margin;
    let left = anchorRect.left;
    const maxLeft = window.innerWidth - panelRect.width - margin;
    if (left > maxLeft) left = maxLeft;
    if (left < margin) left = margin;
    this.#panel.style.top = top + "px";
    this.#panel.style.left = left + "px";
  }

  #go(tab) {
    this.close();
    this.#bus.call("ui", "navigateTab", { to: tab }).catch((err) => {
      console.error("[UserMenuPopoverView] navigate to " + tab + " failed", err);
      this.#bus.emit("app.error", { source: "UserMenuPopoverView", message: "navigate to " + tab + " failed", severity: "warn", err });
    });
  }

  #disconnect() {
    this.close();
    this.#bus.call("session", "lock", {}).catch((err) => {
      console.error("[UserMenuPopoverView] session lock failed", err);
      this.#bus.emit("app.error", { source: "UserMenuPopoverView", message: "session lock failed", severity: "warn", err });
    });
  }
}
