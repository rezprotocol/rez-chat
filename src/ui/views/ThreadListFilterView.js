import { h } from "@rezprotocol/ui";
import { BusComponent } from "../base/BusComponent.js";
import { materialIcon } from "../base/icon.js";

const FILTERS = [
  { id: "all", icon: "all_inclusive", title: "All threads" },
  { id: "dms", icon: "person", title: "Direct messages" },
  { id: "groups", icon: "groups", title: "Group threads" },
  { id: "locked", icon: "lock", title: "Locked threads" },
  { id: "archived", icon: "archive", title: "Archived threads" },
];

function isHidden(thread) {
  const state = String(thread && thread.visibilityState || "visible").trim().toLowerCase();
  return state === "hidden";
}

function hasUnread(thread) {
  return thread && Number(thread.unreadCount || 0) > 0;
}

export class ThreadListFilterView extends BusComponent {
  #tabEls = new Map();
  #dotEls = new Map();

  constructor({ bus } = {}) {
    super({ bus });
  }

  mount(parentEl) {
    super.mount(parentEl);
    if (!this._rootEl) return;

    this._subscribe(this.bus.stores.uiState, (evt) => {
      if (evt && evt.type === "ui.threadListFilter.changed") {
        this.#updateHighlight();
        this.#updateDots();
      }
    });

    this._listen("threads.updated", () => this.#updateDots());

    this.render();
  }

  render() {
    if (!this._rootEl) return;
    this.#tabEls.clear();
    this.#dotEls.clear();

    const bar = h("div", {
      className: "inline-grid grid-cols-5 gap-1 place-items-center bg-surface-container p-1.5 rounded-lg border border-outline-variant/20",
    }, []);

    for (const tab of FILTERS) {
      const dot = h("span", {
        className: "hidden absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-primary status-glow-cyan",
        "data-role": "filter-dot",
      });
      const btn = h("button", {
        type: "button",
        className: "relative w-9 h-9 flex items-center justify-center rounded-md text-on-surface-variant hover:text-primary hover:bg-surface-container-high transition-all",
        title: tab.title,
        "aria-label": tab.title,
        "data-filter-id": tab.id,
        "data-filter-icon": tab.icon,
      }, [
        materialIcon(tab.icon, { size: 20 }),
        dot,
      ]);
      btn.addEventListener("click", () => this.#handleFilterClick(tab.id));
      this.#tabEls.set(tab.id, btn);
      this.#dotEls.set(tab.id, dot);
      bar.appendChild(btn);
    }

    this._rootEl.replaceChildren(bar);
    this.#updateHighlight();
    this.#updateDots();
  }

  #handleFilterClick(id) {
    const current = this.bus.stores.uiState.threadListFilters();
    const isAll = current.includes("all");

    let next;
    if (id === "all") {
      next = ["all"];
    } else if (isAll) {
      next = [id];
    } else if (current.includes(id)) {
      if (current.length <= 1) {
        next = ["all"];
      } else {
        next = current.filter((f) => f !== id);
      }
    } else {
      next = current.concat(id);
    }

    this.bus.call("ui", "setThreadListFilters", { filters: next }).catch((err) => {
      console.error("[ThreadListFilterView] set filters failed", err);
      this.bus.emit("app.error", { source: "ThreadListFilterView", message: "set filters failed", severity: "warn", err });
    });
  }

  #updateHighlight() {
    const filters = this.bus.stores.uiState.threadListFilters();
    const isAll = filters.includes("all");

    for (const [id, el] of this.#tabEls) {
      const active = id === "all" ? isAll : !isAll && filters.includes(id);
      el.className = active
        ? "relative w-9 h-9 flex items-center justify-center rounded-md bg-primary-container text-on-primary-container transition-all"
        : "relative w-9 h-9 flex items-center justify-center rounded-md text-on-surface-variant hover:text-primary hover:bg-surface-container-high transition-all";
    }
  }

  #updateDots() {
    const threads = this.bus.stores.threads.getThreads();
    const filters = this.bus.stores.uiState.threadListFilters();
    const isAll = filters.includes("all");

    let dmUnread = false;
    let groupUnread = false;
    let archiveUnread = false;

    for (const thread of threads) {
      if (!hasUnread(thread)) continue;
      if (isHidden(thread)) {
        archiveUnread = true;
        continue;
      }
      if (thread.threadType === "direct") dmUnread = true;
      if (thread.threadType === "group") groupUnread = true;
    }

    const dmDotVisible = dmUnread && !isAll && !filters.includes("dms");
    const groupDotVisible = groupUnread && !isAll && !filters.includes("groups");
    const archiveDotVisible = archiveUnread && !isAll && !filters.includes("archived");

    this.#setDotVisible("dms", dmDotVisible);
    this.#setDotVisible("groups", groupDotVisible);
    this.#setDotVisible("archived", archiveDotVisible);
  }

  #setDotVisible(tabId, visible) {
    const dot = this.#dotEls.get(tabId);
    if (!dot) return;
    if (visible) {
      dot.classList.remove("hidden");
    } else {
      dot.classList.add("hidden");
    }
  }
}
