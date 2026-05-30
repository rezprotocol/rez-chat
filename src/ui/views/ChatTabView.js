import { h } from "rez-ui";
import { BusComponent } from "../base/BusComponent.js";
import { ThreadListFilterView } from "./ThreadListFilterView.js";
import { ThreadListView } from "./ThreadListView.js";
import { ThreadPanelView } from "./ThreadPanelView.js";

export class ChatTabView extends BusComponent {
  #filterBar;
  #threadList;
  #threadPanel;
  #rootShell;

  constructor({ bus } = {}) {
    super({ bus });
    this.#filterBar = null;
    this.#threadList = null;
    this.#threadPanel = null;
    this.#rootShell = null;
  }

  mount(parentEl) {
    super.mount(parentEl);
    if (!this._rootEl) return;

    const filterSlot = h("div", {}, []);
    const searchInput = h("input", {
      className: "w-full bg-surface-container border-none text-label-technical font-label-technical py-2.5 pl-10 pr-4 rounded-lg focus:ring-1 focus:ring-primary/30 focus:outline-none placeholder:text-outline-variant text-on-surface transition-all",
      type: "text",
      placeholder: "FILTER BY HASH...",
      "data-role": "thread-search",
      autocomplete: "off",
    });
    const searchWrap = h("div", { className: "relative group" }, [
      h("span", { className: "material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-outline pointer-events-none", style: { fontSize: "18px" } }, "search"),
      searchInput,
    ]);

    const sessionHeader = h("div", { className: "p-space-lg pb-space-md titlebar-drag" }, [
      h("div", { className: "flex items-center justify-between gap-space-md mb-space-md" }, [
        h("h1", { className: "text-headline-md font-headline-md text-on-surface" }, "Chats"),
        filterSlot,
      ]),
      searchWrap,
    ]);

    const listSlot = h("div", { className: "flex-1 overflow-y-auto custom-scrollbar px-space-md pb-space-md" }, []);

    const sidebar = h("aside", {
      className: "rz-chat-sidebar flex w-full lg:w-thread-list-width shrink-0 flex-col border-r border-outline-variant/30 bg-surface-container-lowest/50 backdrop-blur-sm",
    }, [sessionHeader, listSlot]);

    const panelSlot = h("section", { className: "rz-chat-panel flex-1 min-w-0 flex flex-col relative" }, []);

    const shell = h("div", {
      className: "rz-chat-tab flex h-full w-full min-h-0",
      "data-thread-selected": "false",
    }, [sidebar, panelSlot]);
    this.#rootShell = shell;
    this._rootEl.replaceChildren(shell);

    this.#filterBar = new ThreadListFilterView({ bus: this.bus });
    this.#filterBar.mount(filterSlot);
    this.#threadList = new ThreadListView({ bus: this.bus });
    this.#threadList.mount(listSlot);
    this.#threadPanel = new ThreadPanelView({ bus: this.bus });
    this.#threadPanel.mount(panelSlot);

    this._subscribe(this.bus.stores.uiState, (evt) => {
      const type = evt && evt.type;
      if (type === "ui.selectedThread.changed" || type === "ui.reset") this.#syncSelection();
    });
    this.#syncSelection();
  }

  #syncSelection() {
    if (!this.#rootShell) return;
    const selectedId = this.bus.stores.uiState.selectedThreadId();
    this.#rootShell.setAttribute("data-thread-selected", selectedId ? "true" : "false");
  }

  unmount() {
    if (this.#filterBar) { this.#filterBar.unmount(); this.#filterBar = null; }
    if (this.#threadList) { this.#threadList.unmount(); this.#threadList = null; }
    if (this.#threadPanel) { this.#threadPanel.unmount(); this.#threadPanel = null; }
    this.#rootShell = null;
    super.unmount();
  }
}
