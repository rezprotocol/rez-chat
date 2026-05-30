import { h } from "rez-ui";
import { BusComponent } from "../base/BusComponent.js";

const REZ_SPLASH_IMAGE_URL = new URL(
  "../../../../rez-ui/branding/rez-animated-splash-binary-glitch-pack/rez-binary-glitch-splash-640x360.gif",
  import.meta.url,
).href;

function resolveStatusLabel(initStep, connection) {
  if (initStep === "CONNECTING_TO_REZNET") return "CONNECTING TO NODE";
  if (initStep === "LINKING_TO_REZNET") return "LINKING TO REZ NETWORK";
  if (initStep === "REZNET_READY") return "REZ NETWORK READY";
  const status = String(connection && connection.status || "").trim();
  if (status === "connecting") return "CONNECTING TO NODE";
  return "LOADING SESSION";
}

function resolveDetail(connection) {
  const mesh = connection && connection.mesh && typeof connection.mesh === "object" ? connection.mesh : null;
  if (!mesh) return "Establishing secure session";
  const peerCount = Number(mesh.peerCount || 0);
  if (peerCount > 0) {
    return "Discovered " + String(peerCount) + " peer" + (peerCount === 1 ? "" : "s");
  }
  return "Session online";
}

export class SplashView extends BusComponent {
  mount(parentEl) {
    super.mount(parentEl);
    if (!this._rootEl) return;
    const stores = this.bus.stores;
    this._subscribe(stores.session, () => this.render());
    this._subscribe(stores.connection, () => this.render());
    this.render();
  }

  render() {
    if (!this._rootEl) return;
    const stores = this.bus.stores;
    const initStep = stores.session.initStep() || "";
    const connection = stores.connection.getConnection();
    const statusLabel = resolveStatusLabel(initStep, connection);
    const detail = resolveDetail(connection);
    const error = String(connection && connection.lastError || "").trim();

    const card = h("div", {
      className: "tactile-card-login rounded-xl p-space-xl flex flex-col items-center w-full max-w-[560px]",
    }, [
      h("div", { className: "light-leak" }),
      h("div", { className: "flex flex-col items-center gap-space-lg w-full" }, [
        h("img", {
          src: REZ_SPLASH_IMAGE_URL,
          alt: "Rez loading splash",
          className: "block h-auto w-full max-w-[420px] select-none rounded-lg",
          draggable: "false",
        }),
        h("div", { className: "text-center" }, [
          h("p", {
            className: "font-label-technical text-label-technical text-primary/70 uppercase tracking-[0.3em]",
          }, statusLabel),
          h("p", {
            className: "mt-space-sm font-label-technical text-label-technical text-on-surface-muted",
          }, detail),
        ]),
        error ? h("div", {
          className: "w-full max-w-sm px-space-md py-space-sm rounded-lg border border-error/40 bg-error/10 text-error font-label-technical text-label-technical text-center",
        }, error) : null,
      ]),
    ]);

    const main = h("main", {
      className: "rez-app min-h-screen w-full flex items-center justify-center p-space-md relative overflow-hidden",
    }, [
      h("div", { className: "fixed inset-0 pointer-events-none z-0" }, [
        h("div", { className: "absolute inset-0 bg-gradient-to-t from-black via-transparent to-transparent opacity-40" }),
        h("div", {
          className: "absolute top-0 left-0 w-full h-full opacity-10 bg-[radial-gradient(#01daf3_1px,transparent_1px)] [background-size:32px_32px]",
        }),
      ]),
      h("div", { className: "w-full max-w-[560px] z-10" }, [card]),
    ]);

    this._rootEl.replaceChildren(main);
  }
}
