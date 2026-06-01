import { h } from "@rezprotocol/ui";
import { BusComponent } from "../base/BusComponent.js";
import { materialIcon } from "../base/icon.js";
import { shortId } from "../presenters/labels.js";

/**
 * SystemEventRowView: centered, muted timeline row for a chat-system event
 * persisted as a ChatSystemEventPayloadV1. Today's only `event` value is
 * `member.join`; structured this way so adding `member.leave`, `member.kick`,
 * `group.renamed`, etc. is a switch-case extension, not a new component.
 *
 * System messages are immutable once persisted, so the row renders once on
 * mount and only re-renders when contacts change (to pick up a freshly-
 * known display name for the actor when the message arrived before we had
 * a contact record).
 */
export class SystemEventRowView extends BusComponent {
  constructor({ bus, threadId, messageId } = {}) {
    super({ bus });
    this._threadId = String(threadId || "").trim();
    this._messageId = String(messageId || "").trim();
  }

  get messageId() { return this._messageId; }

  mount(parentEl) {
    super.mount(parentEl);
    if (!this._rootEl) return;
    const stores = this.bus.stores || {};
    if (stores.contacts) {
      this._subscribe(stores.contacts, () => this.render());
    }
    this.render();
  }

  render() {
    if (!this._rootEl) return;
    const message = this.#getMessage();
    if (!message) {
      this._rootEl.replaceChildren();
      return;
    }
    const payload = message.payload && typeof message.payload === "object" ? message.payload : null;
    if (!payload) {
      this._rootEl.replaceChildren();
      return;
    }
    const text = this.#renderText(payload);
    if (!text) {
      this._rootEl.replaceChildren();
      return;
    }
    const timeLabel = this.#formatTime(message.createdAtMs || payload.actedAtMs || 0);
    this._rootEl.replaceChildren(
      h("div", {
        className: "w-full flex items-center justify-center my-2",
      }, [
        h("div", {
          className: "flex items-center gap-1.5 text-on-surface-variant/70 text-label-sm font-label-sm",
        }, [
          materialIcon(this.#iconFor(payload.event), { size: 14, className: "text-on-surface-variant/60" }),
          h("span", { className: "" }, text),
          timeLabel ? h("span", { className: "text-on-surface-variant/40" }, "· " + timeLabel) : null,
        ].filter(Boolean)),
      ]),
    );
  }

  #getMessage() {
    return this.bus.stores.messages.getMessage(this._threadId, this._messageId);
  }

  #renderText(payload) {
    if (payload.event === "member.join") {
      const label = this.#actorLabel(payload);
      return label + " joined the group";
    }
    return "";
  }

  #iconFor(event) {
    if (event === "member.join") return "person_add";
    return "info";
  }

  #actorLabel(payload) {
    const actorId = String(payload.actorAccountId || "").trim();
    const queries = this.bus.queries;
    const resolved = (queries && queries.contacts && actorId) ? queries.contacts.displayName(actorId) : null;
    if (resolved) return resolved;
    // Fall back to the display-name hint captured at persist time so the row
    // still says something useful before contacts arrive.
    const hint = typeof payload.actorDisplayName === "string" ? payload.actorDisplayName.trim() : "";
    if (hint) return hint;
    if (actorId) return shortId(actorId, 12);
    return "Someone";
  }

  #formatTime(ms) {
    if (!ms || !Number.isFinite(ms)) return "";
    return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
}
