import { h } from "@rezprotocol/ui";
import { BusComponent } from "../base/BusComponent.js";
import { materialIcon } from "../base/icon.js";
import { avatarInitials, avatarHue } from "../presenters/labels.js";

/**
 * ConnectRequestAlertView: an in-app, non-blocking alert stack (bottom-right)
 * that surfaces INCOMING connect requests with Approve/Deny buttons — the
 * actionable "desktop alert" the native Notification API can't provide (it has
 * no action buttons in this renderer). Driven by the ConnectRequestStore;
 * a card is shown per pending incoming request until acted on or dismissed.
 */
export class ConnectRequestAlertView extends BusComponent {
  #dismissed;

  constructor({ bus } = {}) {
    super({ bus });
    this.#dismissed = new Set();
  }

  mount(parentEl) {
    super.mount(parentEl);
    if (!this._rootEl) return;
    const stores = this.bus.stores || {};
    if (stores.connectRequests) {
      this._subscribe(stores.connectRequests, () => this.render());
    }
    if (stores.contacts) {
      this._subscribe(stores.contacts, () => this.render());
    }
    this.render();
  }

  render() {
    if (!this._rootEl) return;
    const queries = this.bus.queries;
    const requests = queries && queries.contacts && typeof queries.contacts.incomingConnectRequests === "function"
      ? queries.contacts.incomingConnectRequests() : [];
    const visible = requests.filter((r) => r && !this.#dismissed.has(String(r.peerAccountId || "").trim()));
    if (!visible.length) {
      this._rootEl.replaceChildren();
      return;
    }
    this._rootEl.replaceChildren(h("div", {
      className: "fixed bottom-4 right-4 z-50 flex flex-col gap-2 w-80 max-w-[calc(100vw-2rem)]",
      "data-role": "connect-request-alerts",
    }, visible.map((req) => this._buildCard(req))));
  }

  _buildCard(req) {
    const peerId = String(req && req.peerAccountId || "").trim();
    const queries = this.bus.queries;
    const knownName = queries && queries.contacts ? queries.contacts.displayName(peerId) : null;
    const hintName = req && typeof req.displayName === "string" ? req.displayName.trim() : "";
    const name = knownName || hintName || peerId;

    const approveBtn = h("button", {
      type: "button",
      className: "flex-1 bg-primary-container text-on-primary-container border border-primary/40 px-space-md py-2 rounded-lg font-label-technical text-label-technical font-bold hover:bg-primary hover:text-on-primary transition-all cursor-pointer",
    }, "Approve");
    approveBtn.addEventListener("click", () => {
      approveBtn.disabled = true;
      this.bus.call("contacts", "approveConnectRequest", { accountId: peerId }).catch((err) => {
        approveBtn.disabled = false;
        console.error("[ConnectRequestAlertView] approve failed", err);
        this.bus.emit("app.error", { source: "ConnectRequestAlertView", message: "approve failed", severity: "warn", err });
      });
    });

    const denyBtn = h("button", {
      type: "button",
      className: "flex-1 bg-surface-container-high border border-outline-variant/40 px-space-md py-2 rounded-lg text-on-surface-variant font-label-technical text-label-technical font-bold hover:border-error/40 hover:text-error transition-all cursor-pointer",
    }, "Deny");
    denyBtn.addEventListener("click", () => {
      denyBtn.disabled = true;
      this.bus.call("contacts", "denyConnectRequest", { accountId: peerId }).catch((err) => {
        denyBtn.disabled = false;
        console.error("[ConnectRequestAlertView] deny failed", err);
        this.bus.emit("app.error", { source: "ConnectRequestAlertView", message: "deny failed", severity: "warn", err });
      });
    });

    const closeBtn = h("button", {
      type: "button",
      className: "w-6 h-6 flex items-center justify-center rounded text-on-surface-variant/60 hover:text-on-surface transition-colors shrink-0",
      title: "Dismiss",
      "aria-label": "Dismiss",
    }, [materialIcon("close", { size: 16 })]);
    closeBtn.addEventListener("click", () => {
      this.#dismissed.add(peerId);
      this.render();
    });

    return h("div", {
      className: "bg-surface-container-high border border-outline-variant/40 rounded-xl shadow-lg p-space-md flex flex-col gap-space-sm",
      "data-connect-alert-peer": peerId,
    }, [
      h("div", { className: "flex items-center gap-space-sm" }, [
        h("div", {
          className: "w-8 h-8 rounded-lg flex items-center justify-center text-on-surface text-label-micro font-label-technical font-bold shrink-0",
          style: { background: "hsla(" + avatarHue(peerId) + ",55%,30%,0.9)" },
        }, avatarInitials(name)),
        h("div", { className: "flex flex-col flex-1 min-w-0" }, [
          h("p", { className: "text-body-sm font-body-sm text-on-surface font-bold truncate" }, name),
          h("p", { className: "text-label-micro font-label-technical text-on-surface-variant/60 truncate" }, "wants to connect"),
        ]),
        closeBtn,
      ]),
      h("div", { className: "flex items-center gap-space-sm" }, [denyBtn, approveBtn]),
    ]);
  }
}
