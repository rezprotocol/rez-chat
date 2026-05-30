import { h } from "rez-ui";
import { BusComponent } from "../base/BusComponent.js";
import { shortId, avatarInitials } from "../presenters/labels.js";

const MAX_AVATAR_SIZE = 256;
const JPEG_QUALITY = 0.85;

export class ProfileSettingsView extends BusComponent {
  #nameInputEl;
  #avatarPreviewEl;
  #fileInputEl;
  #removeAvatarBtnEl;
  #statusEl;
  #avatarDataB64;
  #avatarChanged;

  constructor({ bus } = {}) {
    super({ bus });
    this.#nameInputEl = null;
    this.#avatarPreviewEl = null;
    this.#fileInputEl = null;
    this.#removeAvatarBtnEl = null;
    this.#statusEl = null;
    this.#avatarDataB64 = null;
    this.#avatarChanged = false;
  }

  mount(parentEl) {
    super.mount(parentEl);
    if (!this._rootEl) return;
    this._subscribe(this.bus.stores.session, () => this.#updateFromSession());
    this.render();
  }

  render() {
    if (!this._rootEl) return;
    const accountLabel = this.#resolveSelfLabel();
    const accountId = this.#resolveSelfAccountId();

    const fileInput = h("input", {
      type: "file",
      accept: "image/*",
      className: "hidden",
    });
    this.#fileInputEl = fileInput;

    const initialsSpan = h("span", {
      className: "text-headline-md font-headline-md text-primary",
      "data-role": "avatar-initials",
    }, avatarInitials(accountLabel));

    const avatarPreview = h("div", {
      className: "w-24 h-24 rounded-full bg-primary/20 border-2 border-primary/30 flex items-center justify-center overflow-hidden",
      "data-role": "avatar-preview",
    }, [initialsSpan]);
    this.#avatarPreviewEl = avatarPreview;

    const changePhotoBtn = h("button", {
      type: "button",
      className: "text-label-technical font-label-technical text-primary hover:text-primary/80 transition-colors cursor-pointer mt-space-sm",
    }, "Change photo");
    changePhotoBtn.addEventListener("click", () => {
      if (this.#fileInputEl) this.#fileInputEl.click();
    });

    const removeAvatarBtn = h("button", {
      type: "button",
      className: "hidden text-label-technical font-label-technical text-error hover:text-error/80 transition-colors cursor-pointer mt-1",
      "data-role": "remove-avatar",
    }, "Remove photo");
    this.#removeAvatarBtnEl = removeAvatarBtn;
    removeAvatarBtn.addEventListener("click", () => {
      this.#avatarDataB64 = "";
      this.#avatarChanged = true;
      this.#showAvatarInitials();
      removeAvatarBtn.classList.add("hidden");
    });

    fileInput.addEventListener("change", () => {
      const file = fileInput.files && fileInput.files[0] ? fileInput.files[0] : null;
      if (!file) return;
      this.#processImageFile(file);
      fileInput.value = "";
    });

    const nameInput = h("input", {
      type: "text",
      value: accountLabel,
      placeholder: "Display name...",
      className: "bg-surface-container border border-outline-variant/40 rounded-lg px-space-md py-2 text-label-technical font-label-technical text-on-surface placeholder:text-outline-variant focus:border-primary/60 focus:ring-1 focus:ring-primary/30 focus:outline-none transition-all w-full max-w-sm",
    });
    this.#nameInputEl = nameInput;

    const statusEl = h("p", {
      className: "hidden text-label-micro font-label-technical px-1 pt-1",
      "data-role": "status",
    }, "");
    this.#statusEl = statusEl;

    const saveBtn = h("button", {
      type: "button",
      className: "bg-primary-container text-on-primary-container px-space-xl py-2 rounded-lg font-label-technical text-label-technical font-bold hover:bg-primary hover:text-on-primary transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed",
    }, "Save");
    saveBtn.addEventListener("click", () => this.#handleSave(saveBtn));

    const backBtn = h("button", {
      type: "button",
      className: "bg-surface-container border border-outline-variant/40 px-space-lg py-2 rounded-lg text-on-surface-variant font-label-technical text-label-technical font-bold hover:border-primary/40 hover:text-primary transition-all cursor-pointer",
    }, "Back");
    backBtn.addEventListener("click", () => {
      this.bus.call("ui", "navigateTab", { to: "chat" }).catch((err) => {
        console.error("[ProfileSettingsView] navigate to chat failed", err);
        this.bus.emit("app.error", { source: "ProfileSettingsView", message: "navigate to chat failed", severity: "warn", err });
      });
    });

    const content = h("div", { className: "p-space-xl flex flex-col gap-space-lg max-w-lg overflow-y-auto custom-scrollbar h-full" }, [
      h("h3", { className: "text-headline-md font-headline-md text-on-surface" }, "Profile Settings"),
      h("div", { className: "flex flex-col items-center gap-space-sm" }, [
        avatarPreview,
        changePhotoBtn,
        removeAvatarBtn,
        fileInput,
      ]),
      h("section", { className: "flex flex-col gap-space-sm" }, [
        h("label", { className: "text-label-micro font-label-technical text-outline uppercase tracking-wider" }, "Display Name"),
        nameInput,
      ]),
      h("section", { className: "flex flex-col gap-1" }, [
        h("label", { className: "text-label-micro font-label-technical text-outline uppercase tracking-wider" }, "Account ID"),
        h("p", { className: "text-label-micro font-label-technical text-on-surface-variant/60 break-all" }, shortId(accountId, 40)),
      ]),
      statusEl,
      h("div", { className: "flex gap-space-md mt-space-sm" }, [saveBtn, backBtn]),
    ]);

    this._rootEl.replaceChildren(content);
    this.#loadExistingAvatar();
  }

  #loadExistingAvatar() {
    const mountVersion = this._captureMountVersion();
    this.bus.call("session", "getOwnAvatar", {}).then((result) => {
      if (!this._isMountVersionCurrent(mountVersion)) return;
      const b64 = result && typeof result.avatarDataB64 === "string" ? result.avatarDataB64 : "";
      if (b64) {
        this.#avatarDataB64 = b64;
        this.#showAvatarImage("data:image/jpeg;base64," + b64);
        if (this.#removeAvatarBtnEl) {
          this.#removeAvatarBtnEl.classList.remove("hidden");
        }
      }
    }).catch((err) => {
      this.bus.emit("app.error", { source: "ProfileSettingsView", message: "load existing avatar failed", severity: "info", err });
    });
  }

  #resolveSelfLabel() {
    return this.bus.stores.session.selfLabel() || "Account";
  }

  #resolveSelfAccountId() {
    return this.bus.stores.session.selectedOrVaultAccountId() || "";
  }

  #updateFromSession() {
    if (!this.#nameInputEl) return;
    const label = this.#resolveSelfLabel();
    const initialsEl = this.#avatarPreviewEl && this.#avatarPreviewEl.querySelector("[data-role='avatar-initials']");
    if (initialsEl) {
      initialsEl.textContent = avatarInitials(label);
    }
  }

  #processImageFile(file) {
    const mountVersion = this._captureMountVersion();
    const reader = new FileReader();
    reader.onload = () => {
      if (!this._isMountVersionCurrent(mountVersion)) return;
      const img = new Image();
      img.onload = () => {
        if (!this._isMountVersionCurrent(mountVersion)) return;
        const dataUrl = this.#resizeToJpeg(img);
        const b64Marker = ";base64,";
        const idx = dataUrl.indexOf(b64Marker);
        if (idx < 0) return;
        this.#avatarDataB64 = dataUrl.slice(idx + b64Marker.length);
        this.#avatarChanged = true;
        this.#showAvatarImage(dataUrl);
        if (this.#removeAvatarBtnEl) {
          this.#removeAvatarBtnEl.classList.remove("hidden");
        }
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  }

  #resizeToJpeg(img) {
    const canvas = document.createElement("canvas");
    canvas.width = MAX_AVATAR_SIZE;
    canvas.height = MAX_AVATAR_SIZE;
    const ctx = canvas.getContext("2d");
    const srcSize = Math.min(img.naturalWidth, img.naturalHeight);
    const sx = (img.naturalWidth - srcSize) / 2;
    const sy = (img.naturalHeight - srcSize) / 2;
    ctx.drawImage(img, sx, sy, srcSize, srcSize, 0, 0, MAX_AVATAR_SIZE, MAX_AVATAR_SIZE);
    return canvas.toDataURL("image/jpeg", JPEG_QUALITY);
  }

  #showAvatarImage(dataUrl) {
    if (!this.#avatarPreviewEl) return;
    this.#avatarPreviewEl.replaceChildren(
      h("img", {
        src: dataUrl,
        alt: "Avatar preview",
        className: "w-full h-full object-cover",
      }),
    );
  }

  #showAvatarInitials() {
    if (!this.#avatarPreviewEl) return;
    const label = this.#resolveSelfLabel();
    this.#avatarPreviewEl.replaceChildren(
      h("span", {
        className: "text-headline-md font-headline-md text-primary",
        "data-role": "avatar-initials",
      }, avatarInitials(label)),
    );
  }

  #setStatus(message, isError) {
    if (!this.#statusEl) return;
    this.#statusEl.textContent = message;
    this.#statusEl.className = "text-label-micro font-label-technical px-1 pt-1 " + (isError ? "text-error" : "text-primary");
    this.#statusEl.classList.remove("hidden");
  }

  async #handleSave(saveBtn) {
    const name = this.#nameInputEl ? String(this.#nameInputEl.value || "").trim() : "";
    if (!name) {
      this.#setStatus("Display name cannot be empty.", true);
      return;
    }

    saveBtn.disabled = true;
    saveBtn.textContent = "Saving...";
    this.#statusEl.classList.add("hidden");

    const payload = { displayName: name };
    if (this.#avatarChanged) {
      payload.avatarDataB64 = this.#avatarDataB64 || "";
    }

    try {
      await this.bus.call("session", "updateProfile", payload);
      this.#avatarChanged = false;
      this.#setStatus("Profile saved.", false);
    } catch (err) {
      const msg = err && err.message ? err.message : "Failed to save profile.";
      this.#setStatus(msg, true);
      this.bus.emit("app.error", { source: "ProfileSettingsView", message: "save failed", severity: "warn", err });
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = "Save";
    }
  }
}
