import { h } from "@rezprotocol/ui";
import { BusComponent } from "../base/BusComponent.js";
import { materialIcon } from "../base/icon.js";
import { ellipsisId, avatarInitials, avatarHue } from "../presenters/labels.js";

const APPROVE_BTN_CLASS = "w-7 h-7 flex items-center justify-center rounded text-on-surface-variant hover:text-primary hover:bg-primary/10 transition-colors";
const DENY_BTN_CLASS = "w-7 h-7 flex items-center justify-center rounded text-on-surface-variant hover:text-error hover:bg-error/10 transition-colors";

/**
 * PendingRequestsSectionView: the "Pending" section of the contacts page —
 * lists INCOMING connect requests (a co-member asking to become a direct
 * contact) with Approve/Deny, kept visually separate from active contacts.
 * Self-hides when there are no incoming requests.
 */
export class PendingRequestsSectionView extends BusComponent {
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
    if (!requests.length) {
      this._rootEl.replaceChildren();
      return;
    }

    const header = h("div", {
      className: "px-space-lg pt-space-md pb-1 flex items-center gap-2",
    }, [
      h("span", { className: "text-label-micro font-label-technical text-on-surface-variant/70 uppercase tracking-wide" }, "Pending"),
      h("span", {
        className: "flex items-center justify-center min-w-4 h-4 px-1 rounded-full bg-primary/20 text-primary text-[10px] font-bold leading-none",
      }, String(requests.length)),
    ]);

    const rows = requests.map((req) => this._buildRow(req));

    this._rootEl.replaceChildren(h("div", {
      className: "border-b border-outline-variant/20 pb-space-sm",
      "data-role": "pending-requests-section",
    }, [header, ...rows]));
  }

  _buildRow(req) {
    const peerId = String(req && req.peerAccountId || "").trim();
    const queries = this.bus.queries;
    const knownName = queries && queries.contacts ? queries.contacts.displayName(peerId) : null;
    const hintName = req && typeof req.displayName === "string" ? req.displayName.trim() : "";
    const name = knownName || hintName || peerId;

    const approveBtn = h("button", {
      type: "button",
      className: APPROVE_BTN_CLASS,
      title: "Approve",
      "aria-label": "Approve connection from " + name,
    }, [materialIcon("check", { size: 18 })]);
    approveBtn.addEventListener("click", (evt) => {
      evt.stopPropagation();
      approveBtn.disabled = true;
      this.bus.call("contacts", "approveConnectRequest", { accountId: peerId }).catch((err) => {
        approveBtn.disabled = false;
        console.error("[PendingRequestsSectionView] approve failed", err);
        this.bus.emit("app.error", { source: "PendingRequestsSectionView", message: "approve failed", severity: "warn", err });
      });
    });

    const denyBtn = h("button", {
      type: "button",
      className: DENY_BTN_CLASS,
      title: "Deny",
      "aria-label": "Deny connection from " + name,
    }, [materialIcon("close", { size: 18 })]);
    denyBtn.addEventListener("click", (evt) => {
      evt.stopPropagation();
      denyBtn.disabled = true;
      this.bus.call("contacts", "denyConnectRequest", { accountId: peerId }).catch((err) => {
        denyBtn.disabled = false;
        console.error("[PendingRequestsSectionView] deny failed", err);
        this.bus.emit("app.error", { source: "PendingRequestsSectionView", message: "deny failed", severity: "warn", err });
      });
    });

    return h("div", {
      className: "flex items-center gap-space-sm px-space-lg py-2",
      "data-pending-peer-id": peerId,
    }, [
      h("div", {
        className: "w-8 h-8 rounded-lg flex items-center justify-center text-on-surface text-label-micro font-label-technical font-bold shrink-0",
        style: { background: "hsla(" + avatarHue(peerId) + ",55%,30%,0.9)" },
      }, avatarInitials(name)),
      h("div", { className: "flex flex-col flex-1 min-w-0" }, [
        h("p", { className: "text-body-sm font-body-sm text-on-surface font-bold truncate" }, name),
        h("p", { className: "text-label-micro font-label-technical text-on-surface-variant/60 truncate" }, "wants to connect · " + ellipsisId(peerId, 16)),
      ]),
      h("div", { className: "flex items-center gap-1 shrink-0" }, [approveBtn, denyBtn]),
    ]);
  }
}
