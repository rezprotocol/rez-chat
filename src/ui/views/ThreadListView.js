import { h } from "rez-ui";
import { BusComponent } from "../base/BusComponent.js";
import { ThreadListItemView } from "./ThreadListItemView.js";

const STATE_EMPTY = "empty";
const STATE_LIST = "list";

export class ThreadListView extends BusComponent {
  #itemViews;
  #containerEl;
  #state;

  constructor({ bus } = {}) {
    super({ bus });
    this.#itemViews = new Map();
    this.#containerEl = null;
    this.#state = "";
  }

  mount(parentEl) {
    super.mount(parentEl);
    if (!this._rootEl) return;
    const stores = this.bus.stores || {};
    if (stores.threads) {
      this._subscribe(stores.threads, (evt) => this.#handleStoreEvent(evt));
    }
    if (stores.uiState) {
      this._subscribe(stores.uiState, (evt) => {
        const type = evt && typeof evt.type === "string" ? evt.type : "";
        if (type === "ui.threadListFilter.changed") this.#reconcileMembership();
      });
    }
    this._listen("runtime.connected", () => this.#bootstrap({ force: true }).catch((err) => {
      console.error("[ThreadListView] reconnect bootstrap failed", err);
      this.bus.emit("app.error", { source: "ThreadListView", message: "reconnect bootstrap failed", severity: "warn", err });
    }));
    this.#reconcileMembership();
    if (this.bus.runtime && this.bus.runtime.client) {
      this.#bootstrap().catch((err) => {
        console.error("[ThreadListView] bootstrap failed", err);
        this.bus.emit("app.error", { source: "ThreadListView", message: "bootstrap failed", severity: "warn", err });
      });
    }
  }

  async #bootstrap({ force = false } = {}) {
    await Promise.all([
      this.bus.call("threads", "ensureList", { limit: 100, force }),
      this.bus.call("contacts", "ensureList", { force }),
      this.bus.call("groups", "ensureList", { force }),
    ]).catch((err) => {
      console.error("[ThreadListView] bootstrap calls failed", err);
      this.bus.emit("app.error", { source: "ThreadListView", message: "bootstrap calls failed", severity: "warn", err });
    });
  }

  #handleStoreEvent(evt) {
    const type = evt && typeof evt.type === "string" ? evt.type : "";
    // Membership-affecting events: replaced/removed always; upserted may add a new row
    // or change order. The row itself handles its own field updates via its subscription,
    // so the parent only needs to manage existence + position.
    if (
      type === "threads.replaced"
      || type === "threads.upserted"
      || type === "threads.removed"
      || type === "threads.reset"
    ) {
      this.#reconcileMembership();
    }
  }

  #getOrderedIds() {
    // Reuse the filter logic that lives in ThreadsService.getIds().
    // It returns the visible/ordered subset honoring uiState filters.
    const fn = this.bus.functions && this.bus.functions.threads ? this.bus.functions.threads.getIds : null;
    if (typeof fn === "function") {
      try {
        const result = fn({});
        return Array.isArray(result) ? result.map((id) => String(id || "").trim()).filter(Boolean) : [];
      } catch {
        return [];
      }
    }
    return this.bus.stores.threads.getThreadIds();
  }

  #reconcileMembership() {
    if (!this._rootEl) return;
    const ids = this.#getOrderedIds();

    if (ids.length === 0) {
      if (this.#state !== STATE_EMPTY) {
        this.#teardownItems();
        this.#containerEl = null;
        this._rootEl.replaceChildren(h("p", {
          className: "py-8 text-outline text-label-technical font-label-technical text-center",
        }, "No conversations yet"));
        this.#state = STATE_EMPTY;
      }
      return;
    }

    let container = this.#containerEl;
    if (this.#state !== STATE_LIST || !container || !container.isConnected) {
      container = document.createElement("div");
      container.className = "flex flex-col space-y-2";
      this._rootEl.replaceChildren(container);
      this.#containerEl = container;
      this.#state = STATE_LIST;
    }

    // Build new map of present rows; remove ones that aren't in `ids`.
    const nextSet = new Set(ids);
    for (const [id, view] of [...this.#itemViews]) {
      if (!nextSet.has(id)) {
        view.unmount();
        this.#itemViews.delete(id);
      }
    }

    // Walk `ids` in order. For each:
    //   - if missing, construct + insert at the right position
    //   - if present but in the wrong slot, move it to the right slot
    // Children that are present and already in the right slot are not touched —
    // their own subscriptions handle their internal updates.
    let cursor = container.firstChild;
    for (const id of ids) {
      let view = this.#itemViews.get(id);
      let row;
      if (!view) {
        view = new ThreadListItemView({ bus: this.bus, threadId: id });
        row = document.createElement("div");
        row.dataset.threadId = id;
        view.mount(row);
        this.#itemViews.set(id, view);
        container.insertBefore(row, cursor);
      } else {
        row = container.querySelector('[data-thread-id="' + cssEscape(id) + '"]');
        if (!row) {
          // Lost the DOM node somehow — remount.
          view.unmount();
          view = new ThreadListItemView({ bus: this.bus, threadId: id });
          row = document.createElement("div");
          row.dataset.threadId = id;
          view.mount(row);
          this.#itemViews.set(id, view);
          container.insertBefore(row, cursor);
        } else if (row !== cursor) {
          container.insertBefore(row, cursor);
        }
      }
      cursor = row.nextSibling;
    }
  }

  #teardownItems() {
    for (const view of this.#itemViews.values()) {
      view.unmount();
    }
    this.#itemViews.clear();
  }

  unmount() {
    this.#teardownItems();
    this.#containerEl = null;
    this.#state = "";
    super.unmount();
  }
}

function cssEscape(value) {
  if (typeof CSS !== "undefined" && CSS && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}
