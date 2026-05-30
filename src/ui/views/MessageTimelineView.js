import { h } from "rez-ui";
import { BusComponent } from "../base/BusComponent.js";
import { materialIcon } from "../base/icon.js";
import { MessageBubbleView } from "./MessageBubbleView.js";
import { SystemEventRowView } from "./SystemEventRowView.js";
import { SYSTEM_EVENT_KIND } from "../../records/payloads/ChatSystemEventPayloadV1.js";

const STATE_NONE = "none";
const STATE_EMPTY = "empty";
const STATE_LIST = "list";

export class MessageTimelineView extends BusComponent {
  #itemViews;
  #containerEl;
  #state;
  #currentThreadId;
  #lastSeenLastMessageId;
  #followBottom;
  #scrollListener;
  #loadListener;
  #pendingPinId;

  constructor({ bus } = {}) {
    super({ bus });
    this.#itemViews = new Map();
    this.#containerEl = null;
    this.#state = "";
    this.#currentThreadId = "";
    this.#lastSeenLastMessageId = "";
    this.#followBottom = false;
    this.#scrollListener = null;
    this.#loadListener = null;
    this.#pendingPinId = 0;
  }

  mount(parentEl) {
    super.mount(parentEl);
    if (!this._rootEl) return;
    this.#installScrollContainerListeners();
    const stores = this.bus.stores || {};
    if (stores.uiState) {
      this._subscribe(stores.uiState, (evt) => {
        const type = evt && typeof evt.type === "string" ? evt.type : "";
        if (type === "ui.selectedThread.changed") {
          this.#handleSelectedThreadChange();
        } else if (type === "ui.selectedChannel.changed") {
          const keys = evt && evt.keys ? evt.keys : {};
          if (keys.threadId && keys.threadId !== this.#currentThreadId) return;
          // Channel switch within the same thread: tear down rows and rebuild
          // so the filter applies fresh, and re-follow the bottom of the new
          // channel view.
          this.#teardownItems();
          this.#containerEl = null;
          this.#state = STATE_NONE;
          this.#lastSeenLastMessageId = "";
          this.#followBottom = true;
          this.#reconcileMembership();
        }
      });
    }
    if (stores.messages) {
      this._subscribe(stores.messages, (evt) => {
        const type = evt && typeof evt.type === "string" ? evt.type : "";
        const keys = evt && evt.keys ? evt.keys : {};
        if (keys.threadId && keys.threadId !== this.#currentThreadId) return;
        if (type === "messages.replaced" || type === "messages.upserted") {
          this.#reconcileMembership();
        }
      });
    }
    this._listen("runtime.connected", () => this.#syncAfterReconnect());
    this.#handleSelectedThreadChange();
  }

  #handleSelectedThreadChange() {
    const queries = this.bus.queries;
    const nextThreadId = queries && queries.threads
      ? String(queries.threads.selectedThreadId() || "").trim()
      : "";
    if (nextThreadId === this.#currentThreadId) {
      this.#reconcileMembership();
      return;
    }
    // Tear down rows from the prior thread.
    this.#teardownItems();
    this.#containerEl = null;
    this.#state = STATE_NONE;
    this.#currentThreadId = nextThreadId;
    this.#lastSeenLastMessageId = "";
    this.#followBottom = true;
    this.#reconcileMembership();
    if (nextThreadId) {
      this.#loadSelectedThreadData(nextThreadId);
    }
  }

  #loadSelectedThreadData(threadId) {
    if (!this.bus.runtime || !this.bus.runtime.client) return;
    const stamp = threadId;
    Promise.all([
      this.bus.call("messages", "ensureList", { threadId, limit: 50 }),
      this.bus.call("contacts", "ensureList", {}),
      this.bus.call("groups", "ensureList", {}),
    ]).catch((err) => {
      console.error("[MessageTimelineView] load thread data failed", err);
      this.bus.emit("app.error", { source: "MessageTimelineView", message: "load thread data failed", severity: "warn", err });
    });
    const stores = this.bus.stores || {};
    const thread = stores.threads ? stores.threads.getThread(threadId) : null;
    if (thread && thread.groupId && this.#currentThreadId === stamp) {
      this.bus.call("groups", "ensureMembers", { groupId: thread.groupId }).catch((err) => {
        console.error("[MessageTimelineView] ensureMembers failed", err);
        this.bus.emit("app.error", { source: "MessageTimelineView", message: "ensureMembers failed", severity: "info", err });
      });
    }
  }

  #syncAfterReconnect() {
    if (!this.bus.runtime || !this.bus.runtime.client) return;
    const threadId = this.#currentThreadId;
    if (!threadId) return;
    this.bus.call("messages", "ensureList", { threadId, limit: 50, force: true }).catch((err) => {
      console.error("[MessageTimelineView] sync after reconnect failed", err);
      this.bus.emit("app.error", { source: "MessageTimelineView", message: "sync after reconnect failed", severity: "info", err });
    });
  }

  #getOrderedMessageIds() {
    // MessageStore.getMessagesFor already handles the system-event passthrough
    // (system events render in every channel of the group thread).
    const messages = this.bus.stores.messages.getMessagesFor(
      this.#currentThreadId,
      this.#getCurrentChannelId(),
    );
    return messages.map((m) => m.messageId);
  }

  #getCurrentChannelId() {
    const uiState = this.bus.stores && this.bus.stores.uiState;
    if (!uiState || typeof uiState.getSelectedChannelId !== "function") return "";
    return uiState.getSelectedChannelId(this.#currentThreadId) || "";
  }

  #reconcileMembership() {
    if (!this._rootEl) return;
    const threadId = this.#currentThreadId;
    if (!threadId) {
      if (this.#state !== STATE_NONE) {
        this.#teardownItems();
        this.#containerEl = null;
        this._rootEl.replaceChildren(h("div", {
          className: "min-h-full flex items-center justify-center",
        }, [
          h("div", { className: "flex flex-col items-center text-center" }, [
            materialIcon("chat", { size: 36, className: "text-outline-variant mb-2 block" }),
            h("p", { className: "text-on-surface-variant/60 text-body-sm font-body-sm" }, "Select a conversation to start"),
          ]),
        ]));
        this.#state = STATE_NONE;
        this.#lastSeenLastMessageId = "";
      }
      return;
    }

    const ids = this.#getOrderedMessageIds();
    if (ids.length === 0) {
      if (this.#state !== STATE_EMPTY) {
        this.#teardownItems();
        this.#containerEl = null;
        this._rootEl.replaceChildren(h("div", {
          className: "min-h-full flex items-center justify-center",
        }, [
          h("div", { className: "flex flex-col items-center text-center" }, [
            materialIcon("forum", { size: 36, className: "text-outline-variant mb-2 block" }),
            h("p", { className: "text-on-surface-variant/60 text-body-sm font-body-sm" }, "No messages yet"),
          ]),
        ]));
        this.#state = STATE_EMPTY;
        this.#lastSeenLastMessageId = "";
      }
      return;
    }

    let container = this.#containerEl;
    if (this.#state !== STATE_LIST || !container || !container.isConnected) {
      container = document.createElement("div");
      container.className = "w-full flex flex-col gap-8";
      this._rootEl.replaceChildren(container);
      this.#containerEl = container;
      this.#state = STATE_LIST;
      // Fresh container after a thread switch — follow bottom on first paint.
      this.#followBottom = true;
    }

    const messagesById = this.#getMessagesById();
    const nextSet = new Set(ids);
    for (const [id, view] of [...this.#itemViews]) {
      if (!nextSet.has(id)) {
        view.unmount();
        this.#itemViews.delete(id);
      }
    }

    let cursor = container.firstChild;
    for (const messageId of ids) {
      let view = this.#itemViews.get(messageId);
      let row;
      if (!view) {
        view = this.#buildRowView({ messageId, message: messagesById.get(messageId) });
        row = document.createElement("div");
        row.className = "w-full";
        row.dataset.messageId = messageId;
        view.mount(row);
        this.#itemViews.set(messageId, view);
        container.insertBefore(row, cursor);
      } else {
        row = container.querySelector('[data-message-id="' + cssEscape(messageId) + '"]');
        if (!row) {
          view.unmount();
          view = this.#buildRowView({ messageId, message: messagesById.get(messageId) });
          row = document.createElement("div");
          row.className = "w-full";
          row.dataset.messageId = messageId;
          view.mount(row);
          this.#itemViews.set(messageId, view);
          container.insertBefore(row, cursor);
        } else if (row !== cursor) {
          container.insertBefore(row, cursor);
        }
      }
      cursor = row.nextSibling;
    }

    const lastId = ids[ids.length - 1] || "";
    const lastChanged = lastId !== this.#lastSeenLastMessageId;
    if (lastChanged) this.#lastSeenLastMessageId = lastId;
    // Pin to the bottom on every reconcile while following — image/avatar
    // decode and font swap can grow rows after the initial paint, so a
    // one-shot scroll only when the last id changes leaves us short.
    if (this.#followBottom) {
      this.#scrollToBottom();
    }
  }

  #getMessagesById() {
    const out = new Map();
    const list = this.bus.stores.messages.getMessages(this.#currentThreadId);
    for (const m of list) {
      if (m && typeof m.messageId === "string") out.set(m.messageId, m);
    }
    return out;
  }

  #buildRowView({ messageId, message }) {
    const threadId = this.#currentThreadId;
    if (isSystemMessage(message)) {
      return new SystemEventRowView({ bus: this.bus, threadId, messageId });
    }
    return new MessageBubbleView({ bus: this.bus, threadId, messageId });
  }

  #teardownItems() {
    for (const view of this.#itemViews.values()) {
      view.unmount();
    }
    this.#itemViews.clear();
  }

  #scrollToBottom() {
    if (!(this._rootEl instanceof Element)) return;
    const el = this._rootEl;
    const pin = () => { el.scrollTop = el.scrollHeight; };
    // Pin now, then again after layout settles. Two rAF passes catch
    // late reflows from avatar/image decode and webfont swap that bump
    // row heights after the initial paint.
    pin();
    const token = ++this.#pendingPinId;
    requestAnimationFrame(() => {
      if (token !== this.#pendingPinId) return;
      if (!this.#followBottom || !el.isConnected) return;
      pin();
      requestAnimationFrame(() => {
        if (token !== this.#pendingPinId) return;
        if (!this.#followBottom || !el.isConnected) return;
        pin();
      });
    });
  }

  #installScrollContainerListeners() {
    if (!(this._rootEl instanceof Element)) return;
    const el = this._rootEl;
    this.#scrollListener = () => {
      const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      this.#followBottom = distanceFromBottom <= 24;
    };
    el.addEventListener("scroll", this.#scrollListener, { passive: true });
    // Catch image/avatar decode bumping row heights after paint.
    this.#loadListener = (evt) => {
      const target = evt && evt.target;
      if (!(target instanceof HTMLImageElement)) return;
      if (!el.contains(target)) return;
      if (this.#followBottom) this.#scrollToBottom();
    };
    el.addEventListener("load", this.#loadListener, true);
  }

  #removeScrollContainerListeners() {
    if (this._rootEl instanceof Element) {
      if (this.#scrollListener) {
        this._rootEl.removeEventListener("scroll", this.#scrollListener);
      }
      if (this.#loadListener) {
        this._rootEl.removeEventListener("load", this.#loadListener, true);
      }
    }
    this.#scrollListener = null;
    this.#loadListener = null;
  }

  unmount() {
    this.#removeScrollContainerListeners();
    this.#pendingPinId++;
    this.#teardownItems();
    this.#containerEl = null;
    this.#state = "";
    this.#currentThreadId = "";
    this.#lastSeenLastMessageId = "";
    this.#followBottom = false;
    super.unmount();
  }
}

function isSystemMessage(message) {
  if (!message) return false;
  const payload = message.payload;
  if (!payload || typeof payload !== "object") return false;
  return payload.kind === SYSTEM_EVENT_KIND;
}

function cssEscape(value) {
  if (typeof CSS !== "undefined" && CSS && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}
