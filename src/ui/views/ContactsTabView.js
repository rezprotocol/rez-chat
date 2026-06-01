import { h } from "@rezprotocol/ui";
import { Host } from "@rezprotocol/ui/framework";
import { BusComponent } from "../base/BusComponent.js";
import { materialIcon } from "../base/icon.js";
import { GroupDetailView } from "./GroupDetailView.js";
import { InviteFormsView } from "./InviteFormsView.js";
import { ContactRowView } from "./ContactRowView.js";
import { GroupRowView } from "./GroupRowView.js";

const FILTER_CONTACTS = "contacts";
const FILTER_GROUPS = "groups";
const FILTER_BLOCKED = "blocked";

const STATE_NONE = "none";
const STATE_EMPTY = "empty";
const STATE_LIST = "list";

const PANE_INVITES = "invites";
const PANE_GROUP_DETAIL = "group-detail";

const FILTER_ICONS = {
  [FILTER_CONTACTS]: { icon: "person", title: "Contacts" },
  [FILTER_GROUPS]: { icon: "groups", title: "Groups" },
  [FILTER_BLOCKED]: { icon: "block", title: "Blocked" },
};

function filterButtonClass(active) {
  return active
    ? "relative w-9 h-9 flex items-center justify-center rounded-md bg-primary-container text-on-primary-container transition-all"
    : "relative w-9 h-9 flex items-center justify-center rounded-md text-on-surface-variant hover:text-primary hover:bg-surface-container-high transition-all";
}

export class ContactsTabView extends BusComponent {
  #filter;
  #filterBarEl;
  #listEl;
  #listState;
  #rowViews;
  #paneHost;
  #paneSlotEl;
  #lastSelectedGroupId;

  constructor({ bus } = {}) {
    super({ bus });
    this.#filter = FILTER_CONTACTS;
    this.#filterBarEl = null;
    this.#listEl = null;
    this.#listState = "";
    this.#rowViews = new Map();
    this.#paneHost = null;
    this.#paneSlotEl = null;
    this.#lastSelectedGroupId = null;
  }

  mount(parentEl) {
    super.mount(parentEl);
    if (!this._rootEl) return;
    this.#renderShell();
    const stores = this.bus.stores || {};
    if (stores.contacts) {
      this._subscribe(stores.contacts, (evt) => this.#handleContactsEvent(evt));
    }
    if (stores.groups) {
      this._subscribe(stores.groups, (evt) => this.#handleGroupsEvent(evt));
    }
    if (stores.uiState) {
      this._subscribe(stores.uiState, (evt) => {
        const type = evt && typeof evt.type === "string" ? evt.type : "";
        if (type === "ui.selectedContactGroup.changed") this.#syncPane();
      });
    }
    this.#reconcileList();
    this.#syncPane();
  }

  #renderShell() {
    const sidebar = h("aside", {
      className: "hidden md:flex w-thread-list-width shrink-0 flex-col border-r border-outline-variant/30 bg-surface-container-lowest/50 backdrop-blur-sm",
    }, []);

    const filters = [FILTER_CONTACTS, FILTER_GROUPS, FILTER_BLOCKED];
    this.#filterBarEl = h("div", {
      className: "inline-grid grid-cols-3 gap-1 place-items-center bg-surface-container p-1.5 rounded-lg border border-outline-variant/20",
    }, filters.map((id) => {
      const meta = FILTER_ICONS[id];
      const isActive = this.#filter === id;
      const btn = h("button", {
        type: "button",
        className: filterButtonClass(isActive),
        title: meta.title,
        "aria-label": meta.title,
        "data-contact-filter": id,
      }, [materialIcon(meta.icon, { size: 20 })]);
      btn.addEventListener("click", () => this.#setFilter(id));
      return btn;
    }));

    const header = h("div", { className: "p-space-lg pb-space-md titlebar-drag" }, [
      h("div", { className: "flex items-center justify-between gap-space-md" }, [
        h("h1", { className: "text-headline-md font-headline-md text-on-surface" }, "Contacts"),
        this.#filterBarEl,
      ]),
    ]);
    sidebar.appendChild(header);

    this.#listEl = h("div", { className: "flex-1 overflow-y-auto custom-scrollbar" }, []);
    this.#listState = "";
    sidebar.appendChild(this.#listEl);

    this.#paneSlotEl = h("section", { className: "flex-1 min-w-0 flex flex-col relative h-full chat-canvas-recessed" }, []);

    const layout = h("div", { className: "flex h-full w-full min-h-0" }, [sidebar, this.#paneSlotEl]);
    this._rootEl.replaceChildren(layout);

    this.#paneHost = new Host({
      children: {
        [PANE_INVITES]: () => new InviteFormsView({ bus: this.bus }),
        [PANE_GROUP_DETAIL]: () => new GroupDetailView({
          bus: this.bus,
          groupId: this.#selectedContactGroupId(),
          onBack: () => {
            this.bus.call("ui", "selectContactGroup", { groupId: null }).catch((err) => {
              console.error("[ContactsTabView] clear contact group failed", err);
              this.bus.emit("app.error", { source: "ContactsTabView", message: "clear contact group failed", severity: "warn", err });
            });
          },
        }),
      },
    });
    this.#paneHost.mount(this.#paneSlotEl);
  }

  #selectedContactGroupId() {
    return this.bus.stores.uiState.selectedContactGroupId();
  }

  #syncPane() {
    if (!this.#paneHost) return;
    const selected = this.#selectedContactGroupId();
    if (!selected) {
      this.#paneHost.switchTo(PANE_INVITES);
      this.#lastSelectedGroupId = null;
      return;
    }
    const sameGroup = this.#lastSelectedGroupId === selected;
    this.#paneHost.switchTo(PANE_GROUP_DETAIL, { force: !sameGroup });
    this.#lastSelectedGroupId = selected;
  }

  #handleContactsEvent(evt) {
    const type = evt && typeof evt.type === "string" ? evt.type : "";
    if (this.#filter !== FILTER_CONTACTS && this.#filter !== FILTER_BLOCKED) return;
    if (type === "contacts.replaced" || type === "contacts.upserted"
        || type === "contacts.removed" || type === "contacts.reset") {
      this.#reconcileList();
    }
  }

  #handleGroupsEvent(evt) {
    const type = evt && typeof evt.type === "string" ? evt.type : "";
    if (this.#filter !== FILTER_GROUPS) return;
    if (type === "groups.replaced" || type === "groups.upserted"
        || type === "groups.removed" || type === "groups.reset") {
      this.#reconcileList();
    }
  }

  #setFilter(filter) {
    if (this.#filter === filter) return;
    this.#filter = filter;
    if (this.#filterBarEl) {
      const btns = this.#filterBarEl.querySelectorAll("[data-contact-filter]");
      for (const b of btns) {
        const id = b.getAttribute("data-contact-filter");
        b.className = filterButtonClass(id === filter);
      }
    }
    this.#teardownRows();
    this.#reconcileList();
  }

  #computeDesiredKeys() {
    const stores = this.bus.stores || {};
    const queries = this.bus.queries;
    if (this.#filter === FILTER_CONTACTS || this.#filter === FILTER_BLOCKED) {
      const list = (queries && queries.contacts)
        ? (this.#filter === FILTER_BLOCKED ? queries.contacts.blockedContacts() : queries.contacts.activeContacts())
        : [];
      const keys = [];
      for (const c of list) {
        const id = String(c && c.accountId || "").trim();
        if (id) keys.push(id);
      }
      return { kind: "contact", keys };
    }
    const groups = stores.groups.getGroups();
    const keys = [];
    for (const g of groups) {
      const id = String(g && g.groupId || "").trim();
      if (id) keys.push(id);
    }
    return { kind: "group", keys };
  }

  #reconcileList() {
    if (!this.#listEl) return;
    const { kind, keys } = this.#computeDesiredKeys();

    if (keys.length === 0) {
      if (this.#listState !== STATE_EMPTY) {
        this.#teardownRows();
        const emptyText = this.#filter === FILTER_BLOCKED
          ? "No blocked contacts."
          : this.#filter === FILTER_GROUPS ? "No groups yet." : "No contacts yet.";
        this.#listEl.replaceChildren(h("p", {
          className: "py-8 px-space-lg text-outline text-label-technical font-label-technical text-center",
        }, emptyText));
        this.#listState = STATE_EMPTY;
      }
      return;
    }

    if (this.#listState !== STATE_LIST) {
      this.#listEl.replaceChildren();
      this.#listState = STATE_LIST;
    }

    const desiredSet = new Set(keys);
    for (const [id, view] of [...this.#rowViews]) {
      if (!desiredSet.has(id) || view.kind !== kind) {
        view.view.unmount();
        this.#rowViews.delete(id);
      }
    }

    let cursor = this.#listEl.firstChild;
    for (const id of keys) {
      let entry = this.#rowViews.get(id);
      let row;
      if (!entry || entry.kind !== kind) {
        const view = kind === "contact"
          ? new ContactRowView({ bus: this.bus, accountId: id })
          : new GroupRowView({ bus: this.bus, groupId: id });
        row = document.createElement("div");
        row.dataset.rowKey = id;
        view.mount(row);
        entry = { kind, view, row };
        this.#rowViews.set(id, entry);
        this.#listEl.insertBefore(row, cursor);
      } else {
        row = entry.row;
        if (row !== cursor) {
          this.#listEl.insertBefore(row, cursor);
        }
      }
      cursor = row.nextSibling;
    }

    if (this.#listState === STATE_NONE) this.#listState = STATE_LIST;
  }

  #teardownRows() {
    for (const entry of this.#rowViews.values()) entry.view.unmount();
    this.#rowViews.clear();
  }

  unmount() {
    this.#teardownRows();
    if (this.#paneHost) {
      this.#paneHost.unmount();
      this.#paneHost = null;
    }
    this.#paneSlotEl = null;
    this.#listEl = null;
    this.#filterBarEl = null;
    this.#listState = "";
    this.#filter = FILTER_CONTACTS;
    this.#lastSelectedGroupId = null;
    super.unmount();
  }
}
