import { h } from "@rezprotocol/ui";
import { BusComponent } from "../base/BusComponent.js";
import { materialIcon } from "../base/icon.js";
import { OwnAvatarView } from "./OwnAvatarView.js";
import { ResetPasswordWithPhraseModal } from "./ResetPasswordWithPhraseModal.js";
import { ImportBackupModal } from "./ImportBackupModal.js";
import { LegacyAccountMigrationModal } from "./LegacyAccountMigrationModal.js";
import { SESSION_STATUS } from "../stores/SessionStore.js";

const REZ_FULL_LOGO_URL = new URL(
  "../../../../rez-ui/branding/filled-silhouette/rez-icon-full-transparent-filled.png",
  import.meta.url,
).href;

export class LoginUnlockView extends BusComponent {
  #avatarViews;
  #autoPromptAttempted;

  constructor({ bus } = {}) {
    super({ bus });
    this.#avatarViews = [];
    this.#autoPromptAttempted = false;
  }

  mount(parentEl) {
    super.mount(parentEl);
    if (!this._rootEl) return;
    this._sessionStore = this.bus.stores.session;
    this._subscribe(this._sessionStore, () => {
      this.render();
      this.#maybeAutoPromptDeviceUnlock();
    });
    this.render();
    this.#maybeAutoPromptDeviceUnlock();
  }

  #maybeAutoPromptDeviceUnlock() {
    if (this.#autoPromptAttempted) return;
    const sessionStore = this._sessionStore;
    if (sessionStore.status() !== SESSION_STATUS.LOCKED) return;
    const selectedAccountId = sessionStore.selectedAccountIdRaw();
    if (!selectedAccountId) return;
    const selected = sessionStore.accountEntry(selectedAccountId);
    if (!selected || selected.deviceUnlockEnabled !== true) return;
    // Never auto-unlock a pre-BIP39 account — it would succeed at the vault but
    // fail at connect(). The lock screen routes it through re-create instead.
    if (selected.recoveryEnabled === false) return;
    this.#autoPromptAttempted = true;
    this.bus.call("session", "unlockWithDevice", { accountId: selectedAccountId }).catch((err) => {
      const code = err && err.code ? String(err.code) : "";
      if (code === "BIOMETRIC_CANCELLED") return;
      console.error("[LoginUnlockView] device unlock failed", err);
      this.bus.emit("app.error", { source: "LoginUnlockView", message: "device unlock failed", severity: "warn", err });
    });
  }

  render() {
    if (!this._rootEl) return;
    const sessionStore = this._sessionStore;
    const status = sessionStore.status();
    const error = sessionStore.error() || "";
    const selectedAccountId = sessionStore.selectedAccountIdRaw() || "";
    const accountList = sessionStore.accountList();
    const selectedAccount = sessionStore.selectedAccountEntry();
    const selectedDeviceUnlockEnabled = !!(selectedAccount && selectedAccount.deviceUnlockEnabled === true);
    // Pre-BIP39 account selected: no recovery phrase, no backup, no unlock path
    // that survives connect(). Refuse the unlock form and route to re-create.
    const selectedIsLegacy = !!(selectedAccount && selectedAccount.recoveryEnabled === false);
    const otherAccounts = sessionStore.otherAccountEntries();
    const busy = status === SESSION_STATUS.UNLOCKING || status === SESSION_STATUS.INITIALIZING;

    const passwordInput = h("input", {
      id: "rz-unlock-passcode",
      className: "w-full bg-surface-container-low border border-glass-border rounded-lg pl-space-md pr-12 py-3 font-label-technical text-label-technical text-white focus:ring-1 focus:ring-primary/50 focus:border-primary/50 focus:outline-none transition-all placeholder:font-label-technical",
      type: "password",
      placeholder: "PASSWORD",
      autocomplete: "current-password",
      "data-role": "unlock-password",
    });

    const visibilityIcon = materialIcon("visibility_off", { size: 20, className: "text-outline hover:text-primary transition-colors" });
    const visibilityToggle = h("button", {
      type: "button",
      className: "absolute right-3 top-1/2 -translate-y-1/2 flex items-center justify-center",
      "aria-label": "Toggle password visibility",
      "data-role": "unlock-password-toggle",
    }, [visibilityIcon]);
    visibilityToggle.addEventListener("click", () => {
      const isPassword = passwordInput.type === "password";
      passwordInput.type = isPassword ? "text" : "password";
      const next = materialIcon(isPassword ? "visibility" : "visibility_off", { size: 20, className: "text-outline hover:text-primary transition-colors" });
      visibilityToggle.replaceChildren(next);
    });

    const passcodeField = h("div", { className: "flex flex-col space-y-1.5" }, [
      h("div", { className: "flex justify-between items-center px-1" }, [
        h("label", {
          className: "font-label-micro text-label-micro text-outline uppercase",
          for: "rz-unlock-passcode",
        }, "Passcode_Field"),
        h("span", { className: "font-label-micro text-label-micro text-primary/40" }, "ENC_V2.1"),
      ]),
      h("div", { className: "relative" }, [passwordInput, visibilityToggle]),
    ]);

    const rememberDeviceCheckbox = h("input", {
      type: "checkbox",
      className: "peer appearance-none w-4 h-4 rounded-sm border border-outline-variant bg-transparent checked:bg-primary checked:border-primary transition-all cursor-pointer",
      "data-role": "remember-device",
    });
    const rememberDeviceLabel = h("label", {
      className: "flex items-center space-x-3 cursor-pointer group",
    }, [
      h("div", { className: "relative flex items-center justify-center" }, [
        rememberDeviceCheckbox,
        h("span", {
          className: "material-symbols-outlined absolute text-[12px] text-on-primary opacity-0 peer-checked:opacity-100 transition-opacity pointer-events-none",
        }, "check"),
      ]),
      h("span", {
        className: "font-label-technical text-label-technical text-on-surface-muted group-hover:text-primary transition-colors",
      }, "REMEMBER_ON_THIS_DEVICE"),
    ]);

    const decryptButton = h("button", {
      type: "submit",
      className: "decrypt-glow w-full bg-primary-container text-on-primary-container font-label-technical text-label-technical py-2.5 rounded-lg flex items-center justify-center space-x-2 active:scale-[0.98] transition-all duration-200 mt-space-lg group disabled:opacity-50 disabled:cursor-not-allowed",
      "data-action": "session.unlock",
      "aria-disabled": busy ? "true" : "false",
      disabled: busy ? "" : null,
    }, [
      materialIcon("lock_open", { size: 18, className: "group-hover:animate-pulse" }),
      h("span", { className: "font-extrabold tracking-widest" }, busy ? "CONNECTING" : "DECRYPT"),
    ]);

    const identityPill = selectedAccount ? this.#renderIdentityPill(selectedAccount) : null;
    const switchList = otherAccounts.length > 0 ? this.#renderSwitchList(otherAccounts) : null;

    const footerLinks = h("div", { className: "flex flex-col items-center gap-space-sm pt-space-md" }, [
      selectedDeviceUnlockEnabled ? h("button", {
        type: "button",
        className: "font-label-technical text-label-technical text-outline hover:text-primary transition-all",
        "data-action": "session.disableDeviceUnlock",
      }, "FORGET_DEVICE_UNLOCK") : null,
      selectedAccountId && !selectedIsLegacy ? h("button", {
        type: "button",
        className: "font-label-technical text-label-technical text-outline hover:text-primary transition-all",
        "data-action": "session.forgotPassword",
      }, "FORGOT_PASSWORD") : null,
      h("button", {
        type: "button",
        className: "font-label-technical text-label-technical text-outline hover:text-primary transition-all",
        "data-action": "session.restoreBackup",
      }, "RESTORE_FROM_BACKUP"),
      accountList.length === 0 ? h("button", {
        type: "button",
        className: "font-label-technical text-label-technical text-outline hover:text-primary transition-all",
        "data-action": "authScreen.showCreate",
      }, "ADD_NEW_NODE") : null,
      h("button", {
        type: "button",
        className: "font-label-technical text-label-technical text-outline hover:text-primary transition-all flex items-center gap-1 group",
        "data-action": "session.inspectBootstrap",
      }, [
        materialIcon("settings_input_component", {
          size: 14,
          className: "group-hover:rotate-180 transition-transform duration-500",
        }),
        h("span", null, "AUTH_DEBUG"),
      ]),
    ]);

    // Pre-BIP39 account: swap the password/DECRYPT controls for a re-create
    // notice + button. The unlock form is deliberately absent so the account
    // cannot be unlocked into a broken (connect-failing) state.
    const legacyPanel = selectedIsLegacy ? h("div", { className: "w-full flex flex-col gap-space-sm" }, [
      h("div", {
        className: "w-full px-space-md py-space-sm rounded-lg border border-error/40 bg-error/10 text-error font-label-technical text-label-technical",
      }, "This account predates recovery phrases and can't be unlocked. Re-create it to enable recovery — its local data on this device will be deleted."),
      h("button", {
        type: "button",
        className: "decrypt-glow w-full bg-error/90 text-on-error font-label-technical text-label-technical py-2.5 rounded-lg flex items-center justify-center space-x-2 active:scale-[0.98] transition-all duration-200 group",
        "data-action": "session.migrateLegacy",
      }, [
        materialIcon("autorenew", { size: 18, className: "group-hover:animate-pulse" }),
        h("span", { className: "font-extrabold tracking-widest" }, "RE-CREATE ACCOUNT"),
      ]),
    ]) : null;

    const form = h("form", {
      className: "w-full space-y-space-md",
      "data-role": "unlock-form",
    }, selectedIsLegacy ? [
      identityPill,
      switchList,
      legacyPanel,
      footerLinks,
    ] : [
      identityPill,
      switchList,
      passcodeField,
      rememberDeviceLabel,
      decryptButton,
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
      h("div", { className: "fixed inset-0 pointer-events-none z-0" }, [
        h("div", { className: "absolute inset-0 bg-gradient-to-t from-black via-transparent to-transparent opacity-40" }),
        h("div", {
          className: "absolute top-0 left-0 w-full h-full opacity-10 bg-[radial-gradient(#01daf3_1px,transparent_1px)] [background-size:32px_32px]",
        }),
      ]),
      h("div", { className: "w-full max-w-[420px] z-10" }, [card]),
    ]);

    this.#wireFormHandlers(main, passwordInput, selectedAccountId, status, selectedIsLegacy);

    this._rootEl.replaceChildren(main);
    this.#mountAvatarViews(main, accountList);
  }

  #renderIdentityPill(account) {
    const id = String(account && account.id || "").trim();
    const label = String(account && account.label || "Account").trim();
    return h("div", {
      className: "group relative flex items-center p-space-sm bg-surface-container rounded-lg border border-glass-border hover:border-primary/30 transition-all duration-300 cursor-default overflow-hidden",
    }, [
      h("div", { className: "absolute inset-0 shimmer pointer-events-none" }),
      h("div", {
        className: "w-10 h-10 mr-space-md flex-shrink-0",
        "data-avatar-account-id": id,
        "data-avatar-role": "primary",
      }),
      h("div", { className: "flex flex-col min-w-0" }, [
        h("span", {
          className: "font-label-technical text-label-technical text-on-surface-muted leading-tight",
        }, "NODE_IDENTITY"),
        h("span", {
          className: "font-label-technical text-primary font-bold truncate",
        }, label),
      ]),
      h("div", { className: "ml-auto pl-space-sm flex-shrink-0" }, [
        materialIcon("verified_user", {
          className: "text-primary/40 group-hover:text-primary transition-colors",
        }),
      ]),
    ]);
  }

  #renderSwitchList(otherAccounts) {
    return h("div", { className: "flex flex-col gap-1" }, [
      h("span", {
        className: "font-label-micro text-label-micro text-outline uppercase px-1",
      }, "Switch_Node"),
      ...otherAccounts.map((account) => {
        const id = String(account && account.id || "").trim();
        const label = String(account && account.label || "Account").trim();
        return h("button", {
          type: "button",
          className: "w-full flex items-center gap-space-sm px-space-sm py-2 rounded-lg border border-outline-variant/30 hover:border-primary/30 hover:bg-primary/5 text-on-surface-muted hover:text-primary font-label-technical text-label-technical transition-all",
          "data-account-id": id,
        }, [
          h("div", {
            className: "w-7 h-7 flex-shrink-0",
            "data-avatar-account-id": id,
            "data-avatar-role": "switch",
          }),
          h("span", { className: "truncate" }, label),
        ]);
      }),
    ]);
  }

  #wireFormHandlers(rootEl, passwordInput, selectedAccountId, status, selectedIsLegacy) {
    rootEl.querySelectorAll("[data-account-id]").forEach((el) => {
      el.addEventListener("click", () => {
        const accountId = el.getAttribute("data-account-id");
        this.bus.call("session", "selectAccount", { accountId }).catch((err) => {
          console.error("[LoginUnlockView] select account failed", err);
          this.bus.emit("app.error", { source: "LoginUnlockView", message: "select account failed", severity: "warn", err });
        });
      });
    });

    const unlockForm = rootEl.querySelector("[data-role='unlock-form']");
    if (unlockForm) {
      unlockForm.addEventListener("submit", (event) => {
        event.preventDefault();
        // A legacy account has no password field; ignore a stray Enter-submit.
        if (selectedIsLegacy) return;
        if (status === SESSION_STATUS.UNLOCKING || status === SESSION_STATUS.INITIALIZING) return;
        const rememberEl = rootEl.querySelector("[data-role='remember-device']");
        const enableDeviceUnlock = !!(rememberEl && rememberEl.checked);
        this.bus.call("session", "unlock", {
          accountId: selectedAccountId || null,
          password: passwordInput.value,
          enableDeviceUnlock,
        }).catch((err) => {
          console.error("[LoginUnlockView] unlock failed", err);
          this.bus.emit("app.error", { source: "LoginUnlockView", message: "unlock failed", severity: "warn", err });
        });
      });
    }

    const forgetButton = rootEl.querySelector("[data-action='session.disableDeviceUnlock']");
    if (forgetButton) {
      forgetButton.addEventListener("click", () => {
        this.bus.call("session", "disableDeviceUnlock", { accountId: selectedAccountId || null }).catch((err) => {
          console.error("[LoginUnlockView] disable device unlock failed", err);
          this.bus.emit("app.error", { source: "LoginUnlockView", message: "disable device unlock failed", severity: "warn", err });
        });
      });
    }

    const forgotPasswordButton = rootEl.querySelector("[data-action='session.forgotPassword']");
    if (forgotPasswordButton) {
      forgotPasswordButton.addEventListener("click", () => {
        new ResetPasswordWithPhraseModal({ bus: this.bus, accountId: selectedAccountId || "" }).open();
      });
    }

    const restoreBackupButton = rootEl.querySelector("[data-action='session.restoreBackup']");
    if (restoreBackupButton) {
      restoreBackupButton.addEventListener("click", () => {
        new ImportBackupModal({ bus: this.bus }).open();
      });
    }

    const migrateLegacyButton = rootEl.querySelector("[data-action='session.migrateLegacy']");
    if (migrateLegacyButton) {
      migrateLegacyButton.addEventListener("click", () => {
        new LegacyAccountMigrationModal({ bus: this.bus, accountId: selectedAccountId || "" }).open();
      });
    }

    const showAddButton = rootEl.querySelector("[data-action='authScreen.showCreate']");
    if (showAddButton) {
      showAddButton.addEventListener("click", () => {
        this.bus.call("authScreen", "showCreate", {}).catch((err) => {
          console.error("[LoginUnlockView] show create failed", err);
          this.bus.emit("app.error", { source: "LoginUnlockView", message: "show create failed", severity: "warn", err });
        });
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

  #mountAvatarViews(containerEl, accountList) {
    this.#unmountAvatarViews();
    if (!containerEl || accountList.length === 0) return;
    for (const account of accountList) {
      const id = String(account && account.id || "").trim();
      const label = String(account && account.label || "Account").trim();
      if (!id) continue;
      const slots = containerEl.querySelectorAll("[data-avatar-account-id='" + id + "']");
      slots.forEach((slot) => {
        const role = slot.getAttribute("data-avatar-role") || "switch";
        const sizeClass = role === "primary" ? "size-10" : "size-7";
        const view = new OwnAvatarView({
          bus: this.bus,
          accountId: id,
          label,
          sizeClass,
          roundedClass: "rounded",
        });
        view.mount(slot);
        this.#avatarViews.push(view);
      });
    }
  }

  #unmountAvatarViews() {
    for (const view of this.#avatarViews) {
      view.unmount();
    }
    this.#avatarViews = [];
  }

  unmount() {
    this.#unmountAvatarViews();
    super.unmount();
  }
}
