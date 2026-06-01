import { h } from "@rezprotocol/ui";
import { BusComponent } from "../base/BusComponent.js";
import { ProfileSettingsView } from "./ProfileSettingsView.js";

export class ProfileTabView extends BusComponent {
  #settings;

  constructor({ bus } = {}) {
    super({ bus });
    this.#settings = null;
  }

  mount(parentEl) {
    super.mount(parentEl);
    if (!this._rootEl) return;

    const sidebar = h("aside", {
      className: "hidden md:flex w-thread-list-width shrink-0 flex-col border-r border-outline-variant/30 bg-surface-container-lowest/50 backdrop-blur-sm",
    }, [
      h("div", { className: "p-space-lg pb-space-md titlebar-drag" }, [
        h("h1", { className: "text-headline-md font-headline-md text-on-surface" }, "Profile"),
      ]),
    ]);
    const main = h("section", { className: "flex-1 min-w-0 flex flex-col relative chat-canvas-recessed" }, []);

    this._rootEl.replaceChildren(h("div", { className: "flex h-full w-full min-h-0" }, [sidebar, main]));

    this.#settings = new ProfileSettingsView({ bus: this.bus });
    this.#settings.mount(main);
  }

  unmount() {
    if (this.#settings) { this.#settings.unmount(); this.#settings = null; }
    super.unmount();
  }
}
