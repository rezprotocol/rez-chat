import { h } from "@rezprotocol/ui";
import { BusComponent } from "../base/BusComponent.js";
import { avatarInitials, avatarHue } from "../presenters/labels.js";

const OWN_AVATAR_CACHE = new Map();

export class OwnAvatarView extends BusComponent {
  #accountId;
  #fallbackLabel;
  #sizeClass;
  #roundedClass;
  #revision = 0;
  #pending = null;

  constructor({ bus, accountId, label, sizeClass, roundedClass } = {}) {
    super({ bus });
    this.#accountId = typeof accountId === "string" ? accountId.trim() : "";
    this.#fallbackLabel = typeof label === "string" ? label : "";
    this.#sizeClass = typeof sizeClass === "string" ? sizeClass : "size-8";
    this.#roundedClass = typeof roundedClass === "string" ? roundedClass : "rounded-full";
  }

  mount(parentEl) {
    super.mount(parentEl);
    if (!this._rootEl) return;
    this._listen("session.avatarChanged", (evt) => {
      const changedId = evt && typeof evt.accountId === "string" ? evt.accountId : "";
      if (!changedId || changedId === this.#accountId) {
        this.#revision += 1;
        OWN_AVATAR_CACHE.delete(this.#accountId);
        this.render();
      }
    });
    this._subscribe(this.bus.stores.session, (evt) => {
      const type = evt && evt.type;
      if (type === "session.accountListChanged" || type === "session.changed") {
        this.render();
      }
    });
    this.render();
  }

  #resolveLabel() {
    const fromList = this.bus.stores.session.labelForAccountId(this.#accountId);
    return fromList || this.#fallbackLabel || "Account";
  }

  setAccount(accountId, label) {
    const id = typeof accountId === "string" ? accountId.trim() : "";
    if (id === this.#accountId && label === this.#fallbackLabel) return;
    if (id !== this.#accountId) this.#revision += 1;
    this.#accountId = id;
    this.#fallbackLabel = typeof label === "string" ? label : "";
    this.render();
  }

  render() {
    if (!this._rootEl) return;
    const label = this.#resolveLabel();
    const hue = avatarHue(this.#accountId || label);
    const initials = avatarInitials(label);

    const cached = this.#accountId ? OWN_AVATAR_CACHE.get(this.#accountId) : null;
    const child = cached
      ? h("img", { src: cached, alt: "Avatar", className: "size-full object-cover" })
      : document.createTextNode(initials);

    const el = h("div", {
      className: this.#sizeClass + " " + this.#roundedClass + " flex-shrink-0 ring-1 ring-white/10 flex items-center justify-center text-white/60 text-xs font-mono font-bold overflow-hidden",
      style: { background: "hsla(" + hue + ",55%,30%,0.9)" },
    }, [child]);

    this._rootEl.replaceChildren(el);

    if (this.#accountId && !cached) {
      this.#fetchAvatar();
    }
  }

  #fetchAvatar() {
    const accountId = this.#accountId;
    const revision = this.#revision;
    const mountVersion = this._captureMountVersion();
    const pending = accountId + ":" + revision + ":" + mountVersion;
    if (this.#pending === pending) return;
    this.#pending = pending;
    this.bus.call("session", "getOwnAvatar", { accountId }).then((result) => {
      if (!this._isMountVersionCurrent(mountVersion) || accountId !== this.#accountId || revision !== this.#revision) return;
      const b64 = result && typeof result.avatarDataB64 === "string" ? result.avatarDataB64 : "";
      if (b64) {
        const dataUrl = "data:image/jpeg;base64," + b64;
        OWN_AVATAR_CACHE.set(accountId, dataUrl);
        this.render();
      }
    }).catch((err) => {
      this.bus.emit("app.error", { source: "OwnAvatarView", message: "avatar fetch failed", severity: "info", err });
    }).finally(() => { if (this.#pending === pending) this.#pending = null; });
  }
}
