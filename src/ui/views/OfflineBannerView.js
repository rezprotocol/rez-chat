import { h } from "@rezprotocol/ui";
import { BusComponent } from "../base/BusComponent.js";

/**
 * OfflineBannerView — a full-width red bar across the top of the chat shell
 * whenever the app isn't connected to reznet, the way other chat apps surface
 * a lost connection. It's an autonomous bus-reactive component: it watches the
 * ConnectionStore and shows/hides itself; the rest of the app stays usable
 * underneath (messages queue, history is readable) — we degrade, never block.
 *
 * "connected" is the only fully-online state; anything else (disconnected,
 * offline, connecting, idle) means we can't reach the network → show the bar.
 */
export class OfflineBannerView extends BusComponent {
  mount(parentEl) {
    super.mount(parentEl);
    if (!this._rootEl) return;
    const stores = this.bus.stores || {};
    this._subscribe(stores.connection, () => this.#render());
    this.#render();
  }

  #render() {
    if (!this._rootEl) return;
    const store = this.bus.stores ? this.bus.stores.connection : null;
    const connection = store && typeof store.getConnection === "function" ? store.getConnection() : null;
    const status = String((connection && connection.status) || "disconnected");
    if (status === "connected") {
      this._rootEl.replaceChildren();
      return;
    }
    const message = status === "connecting"
      ? "Connecting to Rez…"
      : "You're offline — reconnecting to Rez…";
    this._rootEl.replaceChildren(h("div", {
      className: "w-full bg-error text-on-error text-center text-sm font-semibold py-2 px-4 shadow-lg select-none z-30",
      role: "alert",
      "data-role": "offline-banner",
      "data-status": status,
    }, [message]));
  }
}
