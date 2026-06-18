import { h } from "@rezprotocol/ui";
import { BusComponent } from "../base/BusComponent.js";
import { materialIcon } from "../base/icon.js";
import { noticeReasonText } from "../system/systemNoticesThread.js";

function formatTime(ms) {
  if (!ms || !Number.isFinite(ms)) return "";
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// One row in the synthetic System thread: a quarantine notice rendered as a
// failed (incoming) message bubble. The deposit is undecryptable, so there is no
// sender, content, or thread to attribute it to — the bubble states that plainly
// and the friendly cause is revealed on hovering the error status (per the
// "failed message + tooltip" surfacing decision). Reads its notice from
// NoticesStore by id; never touches MessageStore.
export class SystemNoticeRowView extends BusComponent {
  #noticeId;

  constructor({ bus, noticeId } = {}) {
    super({ bus });
    this.#noticeId = String(noticeId == null ? "" : noticeId).trim();
  }

  get messageId() {
    return this.#noticeId;
  }

  mount(parentEl) {
    super.mount(parentEl);
    if (!this._rootEl) return;
    const stores = this.bus.stores || {};
    if (stores.notices) {
      this._subscribe(stores.notices, () => this.render());
    }
    this.render();
  }

  render() {
    if (!this._rootEl) return;
    const stores = this.bus.stores || {};
    const entry = stores.notices ? stores.notices.getNotice(this.#noticeId) : null;
    if (!entry) {
      this._rootEl.replaceChildren();
      return;
    }
    const event = entry.event && typeof entry.event === "object" ? entry.event : {};
    const reasonText = noticeReasonText(event);
    const time = formatTime(entry.receivedAtMs);
    const detailTitle = "This message couldn't be decrypted and was " + reasonText + ".";

    const iconBadge = h("div", {
      className: "shrink-0 w-8 h-8 rounded-md bg-error/15 flex items-center justify-center",
    }, [materialIcon("error", { size: 18, className: "text-error" })]);

    const bubbleChildren = [
      h("p", {
        className: "text-body-base text-on-surface break-words [overflow-wrap:anywhere]",
        "data-testid": "systemNotice.text",
      }, "A message couldn't be delivered to you."),
    ];
    if (time) {
      bubbleChildren.push(h("span", {
        className: "block text-right text-label-micro text-outline-variant font-label-technical mt-2",
      }, time));
    }
    const bubbleEl = h("div", {
      className: "chat-bubble-in p-4 rounded-2xl rounded-bl-none relative overflow-hidden max-w-full min-w-0",
      "data-testid": "systemNotice.bubble",
    }, bubbleChildren);

    const statusRow = h("div", {
      className: "flex items-center gap-2 text-label-micro text-error font-label-technical mt-1 cursor-help",
      "data-testid": "systemNotice.status",
      title: detailTitle,
    }, [
      h("span", null, "UNDELIVERED"),
      materialIcon("error", { size: 14, className: "text-error" }),
    ]);

    const innerCol = h("div", { className: "flex flex-col gap-1 min-w-0" }, [
      h("p", {
        className: "text-label-micro font-label-technical uppercase tracking-[0.1em] ml-1 text-error/80",
      }, "System"),
      bubbleEl,
      statusRow,
    ]);
    const innerRow = h("div", { className: "flex items-end gap-3 max-w-[80%] min-w-0 w-fit" }, [
      h("div", { className: "shrink-0 mb-1" }, [iconBadge]),
      innerCol,
    ]);
    const outerEl = h("div", { className: "flex justify-start w-full" }, [innerRow]);
    this._rootEl.replaceChildren(outerEl);
  }
}
