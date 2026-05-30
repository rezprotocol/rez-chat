import { h } from "rez-ui";
import { BusComponent } from "../base/BusComponent.js";
import { avatarInitials, avatarHue } from "../presenters/labels.js";

const AVATAR_CACHE = new Map();

export class ContactAvatarView extends BusComponent {
  #label;
  #fileHashHex;
  #sizeClass;
  #roundedClass;

  constructor({ bus, label, fileHashHex, sizeClass, roundedClass } = {}) {
    super({ bus });
    this.#label = typeof label === "string" ? label : "";
    this.#fileHashHex = typeof fileHashHex === "string" && fileHashHex.length > 0 ? fileHashHex : "";
    this.#sizeClass = typeof sizeClass === "string" ? sizeClass : "size-8";
    this.#roundedClass = typeof roundedClass === "string" ? roundedClass : "rounded-sm";
  }

  mount(parentEl) {
    super.mount(parentEl);
    if (!this._rootEl) return;
    this.render();
  }

  update({ label, fileHashHex } = {}) {
    let changed = false;
    if (typeof label === "string" && label !== this.#label) {
      this.#label = label;
      changed = true;
    }
    if (typeof fileHashHex === "string") {
      const next = fileHashHex.length > 0 ? fileHashHex : "";
      if (next !== this.#fileHashHex) {
        this.#fileHashHex = next;
        changed = true;
      }
    }
    if (changed) this.render();
  }

  render() {
    if (!this._rootEl) return;
    const hue = avatarHue(this.#label);
    const initials = avatarInitials(this.#label);

    const cached = this.#fileHashHex ? AVATAR_CACHE.get(this.#fileHashHex) : null;
    const child = cached
      ? h("img", { src: cached, alt: "Avatar", className: "size-full object-cover" })
      : document.createTextNode(initials);

    const el = h("div", {
      className: this.#sizeClass + " " + this.#roundedClass + " flex-shrink-0 ring-1 ring-white/10 flex items-center justify-center text-white/60 text-xs font-mono font-bold overflow-hidden",
      style: { background: "hsla(" + hue + ",55%,30%,0.9)" },
    }, [child]);

    this._rootEl.replaceChildren(el);

    if (this.#fileHashHex && !cached) {
      this.#fetchAvatar(this.#fileHashHex);
    }
  }

  #fetchAvatar(fileHashHex) {
    const mountVersion = this._captureMountVersion();
    this.bus.call("file", "get", { fileHashHex }).then((result) => {
      if (!this._isMountVersionCurrent(mountVersion)) return;
      if (result && result.fileDataB64 && result.fileDataB64.length > 0) {
        const mime = result.mimeType && result.mimeType.length > 0 ? result.mimeType : "image/jpeg";
        const dataUrl = "data:" + mime + ";base64," + result.fileDataB64;
        AVATAR_CACHE.set(fileHashHex, dataUrl);
        this.render();
      }
    }).catch((err) => {
      this.bus.emit("app.error", { source: "ContactAvatarView", message: "avatar fetch failed", severity: "info", err });
    });
  }
}
