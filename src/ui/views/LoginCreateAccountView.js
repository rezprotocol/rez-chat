import { h } from "@rezprotocol/ui";
import { BusComponent } from "../base/BusComponent.js";
import { materialIcon } from "../base/icon.js";
import { RecoveryPhraseDisplayModal } from "./RecoveryPhraseDisplayModal.js";
import { ImportBackupModal } from "./ImportBackupModal.js";

const REZ_FULL_LOGO_URL = new URL(
  "../../../../rez-ui/branding/filled-silhouette/rez-icon-full-transparent-filled.png",
  import.meta.url,
).href;

export class LoginCreateAccountView extends BusComponent {
  #mode = "create"; // "create" | "link"

  mount(parentEl) {
    super.mount(parentEl);
    if (!this._rootEl) return;
    this._sessionStore = this.bus.stores.session;
    this._subscribe(this._sessionStore, () => this.render());
    this.render();
  }

  render() {
    if (!this._rootEl) return;
    if (this.#mode === "link") {
      this.#renderLinkMode();
      return;
    }
    const sessionStore = this._sessionStore;
    const error = sessionStore.error() || "";
    const accountList = sessionStore.accountList();
    const hasExistingAccounts = accountList.length > 0;

    const nameInput = h("input", {
      id: "rz-signup-name",
      className: "w-full bg-surface-container-low border border-glass-border rounded-lg pl-space-md pr-12 py-3 font-label-technical text-label-technical text-white focus:ring-1 focus:ring-primary/50 focus:border-primary/50 focus:outline-none transition-all placeholder:font-label-technical",
      type: "text",
      placeholder: "ID_ALPHA_772",
      autocomplete: "username",
      "data-role": "signup-name",
    });

    const createPasswordInput = h("input", {
      id: "rz-signup-password",
      className: "w-full bg-surface-container-low border border-glass-border rounded-lg pl-space-md pr-12 py-3 font-label-technical text-label-technical text-white focus:ring-1 focus:ring-primary/50 focus:border-primary/50 focus:outline-none transition-all placeholder:font-label-technical",
      type: "password",
      placeholder: "••••••••••••",
      autocomplete: "new-password",
      "data-role": "signup-password",
    });

    const confirmInput = h("input", {
      id: "rz-signup-confirm",
      className: "w-full bg-surface-container-low border border-glass-border rounded-lg pl-space-md pr-12 py-3 font-label-technical text-label-technical text-white focus:ring-1 focus:ring-primary/50 focus:border-primary/50 focus:outline-none transition-all placeholder:font-label-technical",
      type: "password",
      placeholder: "••••••••••••",
      autocomplete: "new-password",
      "data-role": "signup-confirm",
    });

    const nameField = this.#renderField({
      labelText: "USERNAME / NODE ID",
      htmlFor: "rz-signup-name",
      input: nameInput,
      icon: materialIcon("hub", { size: 20, className: "text-outline" }),
    });
    const passwordField = this.#renderField({
      labelText: "ACCESS KEY",
      htmlFor: "rz-signup-password",
      input: createPasswordInput,
      icon: materialIcon("key", { size: 20, className: "text-outline" }),
    });
    const confirmField = this.#renderField({
      labelText: "CONFIRM ACCESS KEY",
      htmlFor: "rz-signup-confirm",
      input: confirmInput,
      icon: materialIcon("lock", { size: 20, className: "text-outline" }),
    });

    const registerButton = h("button", {
      type: "submit",
      className: "decrypt-glow w-full bg-primary-container text-on-primary-container font-label-technical text-label-technical py-2.5 rounded-lg flex items-center justify-center space-x-2 active:scale-[0.98] transition-all duration-200 mt-space-lg group",
      "data-action": "session.create",
    }, [
      materialIcon("bolt", { size: 18, className: "group-hover:animate-pulse" }),
      h("span", { className: "font-extrabold tracking-[0.2em] uppercase" }, "Register Node"),
    ]);

    const footerLinks = h("div", { className: "flex flex-col items-center gap-space-sm pt-space-md" }, [
      hasExistingAccounts ? h("button", {
        type: "button",
        className: "font-label-technical text-label-technical text-outline hover:text-primary transition-all flex items-center gap-1 group",
        "data-action": "authScreen.showUnlock",
      }, [
        materialIcon("settings_input_component", {
          size: 14,
          className: "group-hover:rotate-180 transition-transform duration-500",
        }),
        h("span", null, "Already Initialized? Access Terminal"),
      ]) : null,
      h("button", {
        type: "button",
        className: "font-label-technical text-label-technical text-outline hover:text-primary transition-all",
        "data-action": "session.linkThisDevice",
      }, "Have an account on another device? Link this device"),
      h("button", {
        type: "button",
        className: "font-label-technical text-label-technical text-outline hover:text-primary transition-all",
        "data-action": "session.restoreBackup",
      }, "Restore From Backup"),
      h("button", {
        type: "button",
        className: "font-label-technical text-label-technical text-outline hover:text-primary transition-all",
        "data-action": "session.inspectBootstrap",
      }, "AUTH_DEBUG"),
    ]);

    const form = h("form", {
      className: "w-full space-y-space-md",
      "data-role": "create-account-form",
    }, [
      nameField,
      passwordField,
      confirmField,
      registerButton,
      footerLinks,
    ]);

    const card = h("div", {
      className: "tactile-card-login rounded-xl p-space-xl flex flex-col items-center",
    }, [
      h("div", { className: "light-leak" }),
      h("div", { className: "flex flex-col items-center mb-space-xl" }, [
        h("img", {
          src: REZ_FULL_LOGO_URL,
          alt: "Rez",
          className: "glitch-logo w-24 h-auto mb-space-sm object-contain select-none",
          draggable: "false",
        }),
        h("p", {
          className: "font-label-technical text-label-technical text-primary/60 mt-space-xs uppercase tracking-[0.2em]",
        }, "Secure Node Access"),
      ]),
      error ? h("div", {
        className: "w-full mb-space-md px-space-md py-space-sm rounded-lg border border-error/40 bg-error/10 text-error font-label-technical text-label-technical",
      }, error) : null,
      form,
    ]);

    const main = h("main", {
      className: "rez-app min-h-screen w-full flex items-center justify-center p-space-md relative overflow-hidden",
    }, [
      h("div", { className: "titlebar-strip" }),
      h("div", { className: "fixed inset-0 pointer-events-none z-0" }, [
        h("div", { className: "absolute inset-0 bg-gradient-to-t from-black via-transparent to-transparent opacity-40" }),
        h("div", {
          className: "absolute top-0 left-0 w-full h-full opacity-10 bg-[radial-gradient(#01daf3_1px,transparent_1px)] [background-size:32px_32px]",
        }),
      ]),
      h("div", { className: "w-full max-w-[420px] z-10" }, [card]),
    ]);

    this.#wireFormHandlers(main, { nameInput, createPasswordInput, confirmInput });

    this._rootEl.replaceChildren(main);
  }

  #renderLinkMode() {
    const error = this._sessionStore.error() || "";
    const unlocking = typeof this._sessionStore.isUnlocking === "function" && this._sessionStore.isUnlocking();

    const codeInput = h("input", {
      id: "rz-link-code",
      className: "w-full bg-surface-container-low border border-glass-border rounded-lg pl-space-md pr-12 py-3 font-label-technical text-label-technical text-white focus:ring-1 focus:ring-primary/50 focus:border-primary/50 focus:outline-none transition-all placeholder:font-label-technical",
      type: "text",
      placeholder: "rez:link:v1:…",
      autocomplete: "off",
      "data-role": "link-code",
    });
    const nameInput = h("input", {
      id: "rz-link-name",
      className: "w-full bg-surface-container-low border border-glass-border rounded-lg pl-space-md pr-12 py-3 font-label-technical text-label-technical text-white focus:ring-1 focus:ring-primary/50 focus:border-primary/50 focus:outline-none transition-all placeholder:font-label-technical",
      type: "text",
      placeholder: "ID_ALPHA_772",
      autocomplete: "username",
      "data-role": "link-name",
    });
    const passwordInput = h("input", {
      id: "rz-link-password",
      className: "w-full bg-surface-container-low border border-glass-border rounded-lg pl-space-md pr-12 py-3 font-label-technical text-label-technical text-white focus:ring-1 focus:ring-primary/50 focus:border-primary/50 focus:outline-none transition-all placeholder:font-label-technical",
      type: "password",
      placeholder: "••••••••••••",
      autocomplete: "new-password",
      "data-role": "link-password",
    });
    const confirmInput = h("input", {
      id: "rz-link-confirm",
      className: "w-full bg-surface-container-low border border-glass-border rounded-lg pl-space-md pr-12 py-3 font-label-technical text-label-technical text-white focus:ring-1 focus:ring-primary/50 focus:border-primary/50 focus:outline-none transition-all placeholder:font-label-technical",
      type: "password",
      placeholder: "••••••••••••",
      autocomplete: "new-password",
      "data-role": "link-confirm",
    });

    const submitButton = h("button", {
      type: "submit",
      className: "decrypt-glow w-full bg-primary-container text-on-primary-container font-label-technical text-label-technical py-2.5 rounded-lg flex items-center justify-center space-x-2 active:scale-[0.98] transition-all duration-200 mt-space-lg group",
      "data-action": "session.linkDevice",
    }, [
      materialIcon("link", { size: 18 }),
      h("span", { className: "font-extrabold tracking-[0.2em] uppercase" }, unlocking ? "Waiting for approval on your other device…" : "Link Device"),
    ]);

    const backButton = h("button", {
      type: "button",
      className: "font-label-technical text-label-technical text-outline hover:text-primary transition-all",
      "data-action": "session.linkBack",
    }, "Back to create account");

    const form = h("form", { className: "w-full space-y-space-md", "data-role": "link-device-form" }, [
      this.#renderField({ labelText: "LINK CODE", htmlFor: "rz-link-code", input: codeInput, icon: materialIcon("qr_code_2", { size: 20, className: "text-outline" }) }),
      this.#renderField({ labelText: "USERNAME / NODE ID", htmlFor: "rz-link-name", input: nameInput, icon: materialIcon("hub", { size: 20, className: "text-outline" }) }),
      this.#renderField({ labelText: "ACCESS KEY", htmlFor: "rz-link-password", input: passwordInput, icon: materialIcon("key", { size: 20, className: "text-outline" }) }),
      this.#renderField({ labelText: "CONFIRM ACCESS KEY", htmlFor: "rz-link-confirm", input: confirmInput, icon: materialIcon("lock", { size: 20, className: "text-outline" }) }),
      submitButton,
      h("div", { className: "flex flex-col items-center gap-space-sm pt-space-md" }, [backButton]),
    ]);

    const card = h("div", { className: "tactile-card-login rounded-xl p-space-xl flex flex-col items-center" }, [
      h("div", { className: "light-leak" }),
      h("div", { className: "flex flex-col items-center mb-space-xl" }, [
        h("img", { src: REZ_FULL_LOGO_URL, alt: "Rez", className: "glitch-logo w-24 h-auto mb-space-sm object-contain select-none", draggable: "false" }),
        h("p", { className: "font-label-technical text-label-technical text-primary/60 mt-space-xs uppercase tracking-[0.2em]" }, "Link This Device"),
      ]),
      error ? h("div", {
        className: "w-full mb-space-md px-space-md py-space-sm rounded-lg border border-error/40 bg-error/10 text-error font-label-technical text-label-technical",
      }, error) : null,
      form,
    ]);

    const main = h("main", {
      className: "rez-app min-h-screen w-full flex items-center justify-center p-space-md relative overflow-hidden",
    }, [
      h("div", { className: "titlebar-strip" }),
      h("div", { className: "w-full max-w-[420px] z-10" }, [card]),
    ]);

    const linkForm = main.querySelector("[data-role='link-device-form']");
    if (linkForm) {
      linkForm.addEventListener("submit", (event) => {
        event.preventDefault();
        this.bus.call("session", "linkDevice", {
          linkCode: codeInput.value,
          name: nameInput.value,
          password: passwordInput.value,
          confirmPassword: confirmInput.value,
        }).catch((err) => {
          console.error("[LoginCreateAccountView] link device failed", err);
          this.bus.emit("app.error", { source: "LoginCreateAccountView", message: "link device failed", severity: "warn", err });
        });
      });
    }
    const backBtn = main.querySelector("[data-action='session.linkBack']");
    if (backBtn) {
      backBtn.addEventListener("click", () => {
        this.#mode = "create";
        this._sessionStore.setError("");
        this.render();
      });
    }

    this._rootEl.replaceChildren(main);
  }

  #renderField({ labelText, htmlFor, input, icon }) {
    return h("div", { className: "flex flex-col space-y-1.5" }, [
      h("div", { className: "flex justify-between items-center px-1" }, [
        h("label", {
          className: "font-label-micro text-label-micro text-outline uppercase",
          for: htmlFor,
        }, labelText),
      ]),
      h("div", { className: "relative" }, [
        input,
        h("div", { className: "absolute right-3 top-1/2 -translate-y-1/2 flex items-center justify-center pointer-events-none" }, [icon]),
      ]),
    ]);
  }

  #wireFormHandlers(rootEl, { nameInput, createPasswordInput, confirmInput }) {
    const createForm = rootEl.querySelector("[data-role='create-account-form']");
    if (createForm) {
      createForm.addEventListener("submit", (event) => {
        event.preventDefault();
        // Capture the password before the await: create() unlocks the session,
        // which switches the scene to 'main' and tears down this view's inputs.
        const capturedPassword = String(createPasswordInput.value || "");
        this.bus.call("session", "create", {
          name: nameInput.value,
          password: capturedPassword,
          confirmPassword: confirmInput.value,
        }).then(() => {
          // Session is now UNLOCKED. Reveal the freshly-minted mnemonic with the
          // captured password and show it for confirmation. The modal mounts on
          // document.body (outside the scene Host), so it survives the scene
          // switch to 'main'.
          return this.bus.call("session", "revealMnemonic", { password: capturedPassword });
        }).then((result) => {
          const mnemonic = result && typeof result.mnemonic === "string" ? result.mnemonic : "";
          // A reveal failure is non-fatal: the account already exists and the
          // user can show the phrase later from Profile Settings. Only open the
          // confirmation modal when we actually have a phrase to show.
          if (!mnemonic) return;
          new RecoveryPhraseDisplayModal({ bus: this.bus, initialMnemonic: mnemonic }).open();
        }).catch((err) => {
          console.error("[LoginCreateAccountView] create account failed", err);
          this.bus.emit("app.error", { source: "LoginCreateAccountView", message: "create account failed", severity: "warn", err });
        });
      });
    }
    const hideAddButton = rootEl.querySelector("[data-action='authScreen.showUnlock']");
    if (hideAddButton) {
      hideAddButton.addEventListener("click", () => {
        this.bus.call("authScreen", "showUnlock", {}).catch((err) => {
          console.error("[LoginCreateAccountView] show unlock failed", err);
          this.bus.emit("app.error", { source: "LoginCreateAccountView", message: "show unlock failed", severity: "warn", err });
        });
      });
    }
    const restoreBackupButton = rootEl.querySelector("[data-action='session.restoreBackup']");
    if (restoreBackupButton) {
      restoreBackupButton.addEventListener("click", () => {
        new ImportBackupModal({ bus: this.bus }).open();
      });
    }
    const linkThisDeviceButton = rootEl.querySelector("[data-action='session.linkThisDevice']");
    if (linkThisDeviceButton) {
      linkThisDeviceButton.addEventListener("click", () => {
        this.#mode = "link";
        this._sessionStore.setError("");
        this.render();
      });
    }

    const inspectButton = rootEl.querySelector("[data-action='session.inspectBootstrap']");
    if (inspectButton) {
      inspectButton.addEventListener("click", () => {
        this.bus.call("session", "inspectBootstrap", {}).then((result) => {
          const payload = result && typeof result.toJSON === "function" ? result.toJSON() : result;
          console.info("[rez-chat] auth bootstrap diagnostic", payload);
        }).catch((err) => {
          console.error("[rez-chat] auth bootstrap diagnostic failed", err && err.message ? err.message : err);
        });
      });
    }
  }
}
