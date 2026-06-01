import { h } from "@rezprotocol/ui";
import { Host } from "@rezprotocol/ui/framework";
import { BusComponent } from "../base/BusComponent.js";
import { ChatTabView } from "./ChatTabView.js";
import { ContactsTabView } from "./ContactsTabView.js";
import { SettingsTabView } from "./SettingsTabView.js";
import { ProfileTabView } from "./ProfileTabView.js";
import { SidebarNavView } from "./SidebarNavView.js";
import { MobileBottomBarView } from "./MobileBottomBarView.js";

export class AppShellView extends BusComponent {
  #sidebarNav;
  #mobileBar;
  #tabHost;

  constructor({ bus } = {}) {
    super({ bus });
    this.#sidebarNav = null;
    this.#mobileBar = null;
    this.#tabHost = null;
  }

  mount(parentEl) {
    super.mount(parentEl);
    if (!this._rootEl) return;

    const navSlot = h("aside", {
      className: "shrink-0 hidden lg:flex z-20",
    }, []);

    const mainArea = h("main", { className: "flex flex-1 min-w-0 min-h-0 overflow-hidden" }, []);
    const tabContent = h("div", { className: "flex flex-1 min-w-0 min-h-0" }, []);
    mainArea.appendChild(tabContent);

    const mobileBarSlot = h("nav", {
      className: "lg:hidden shrink-0 h-16 border-t border-outline-variant/30 bg-surface-dim/80 backdrop-blur-md z-20",
      "data-role": "mobile-bottom-bar",
    }, []);

    this._rootEl.replaceChildren(h("div", {
      className: "flex flex-col lg:flex-row h-screen w-full overflow-hidden bg-gradient-mesh",
    }, [navSlot, mainArea, mobileBarSlot]));

    this.#sidebarNav = new SidebarNavView({ bus: this.bus });
    this.#sidebarNav.mount(navSlot);

    this.#mobileBar = new MobileBottomBarView({ bus: this.bus });
    this.#mobileBar.mount(mobileBarSlot);

    this.#tabHost = new Host({
      children: {
        chat: () => new ChatTabView({ bus: this.bus }),
        contacts: () => new ContactsTabView({ bus: this.bus }),
        settings: () => new SettingsTabView({ bus: this.bus }),
        profile: () => new ProfileTabView({ bus: this.bus }),
      },
    });
    this.#tabHost.mount(tabContent);

    const stores = this.bus.stores || {};
    this._subscribe(stores.uiState, (evt) => {
      if (evt && evt.type === "ui.activeTab.changed") this.#syncTab();
    });
    this.#syncTab();
  }

  #syncTab() {
    if (!this.#tabHost) return;
    this.#tabHost.switchTo(this.bus.stores.uiState.activeTab());
  }

  unmount() {
    if (this.#tabHost) { this.#tabHost.unmount(); this.#tabHost = null; }
    if (this.#mobileBar) { this.#mobileBar.unmount(); this.#mobileBar = null; }
    if (this.#sidebarNav) { this.#sidebarNav.unmount(); this.#sidebarNav = null; }
    super.unmount();
  }
}
