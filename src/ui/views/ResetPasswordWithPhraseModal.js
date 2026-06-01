import { h } from "@rezprotocol/ui";
import { ModalView } from "./ModalView.js";

const MIN_PASSWORD_LENGTH = 8;

/**
 * Forgot-password recovery modal for the lock screen. The user enters their
 * 24-word recovery phrase plus a new password; we submit via
 * `session.resetPasswordWithMnemonic` and surface the vault's error message
 * verbatim on failure — both "Recovery phrase does not match this account"
 * (fingerprint mismatch) and "Cannot reset password without OS-wrapped app
 * data key…" (no OS keychain wrap available on this device).
 *
 * The phrase never leaves the device — it is sent over the local IPC bus to
 * the vault, which re-derives the seed locally. On success the vault is left
 * LOCKED with the new password, so the final step just tells the user to
 * unlock with it; the lock screen underneath is already correct.
 */
export class ResetPasswordWithPhraseModal extends ModalView {
  #accountId;
  #step;
  #errorText;
  #busy;

  constructor({ bus, accountId } = {}) {
    super({ bus });
    this.#accountId = String(accountId || "");
    this.#step = "form";
    this.#errorText = "";
    this.#busy = false;
  }

  renderContent() {
    if (this.#step === "done") return this.#renderDoneStep();
    return this.#renderFormStep();
  }

  #renderFormStep() {
    const phraseInput = h("textarea", {
      rows: "3",
      autocomplete: "off",
      autocorrect: "off",
      autocapitalize: "off",
      spellcheck: "false",
      className: "bg-surface-container-high border border-outline-variant/40 rounded-lg px-space-md py-2 text-label-technical font-label-technical text-on-surface placeholder:text-outline-variant focus:border-primary/60 focus:ring-1 focus:ring-primary/30 focus:outline-none transition-all w-full resize-none",
      placeholder: "Enter your 24-word recovery phrase, words separated by spaces",
    });
    const newInput = h("input", {
      type: "password",
      autocomplete: "new-password",
      className: "bg-surface-container-high border border-outline-variant/40 rounded-lg px-space-md py-2 text-label-technical font-label-technical text-on-surface placeholder:text-outline-variant focus:border-primary/60 focus:ring-1 focus:ring-primary/30 focus:outline-none transition-all w-full",
      placeholder: "New password (8+ characters)",
    });
    const confirmInput = h("input", {
      type: "password",
      autocomplete: "new-password",
      className: "bg-surface-container-high border border-outline-variant/40 rounded-lg px-space-md py-2 text-label-technical font-label-technical text-on-surface placeholder:text-outline-variant focus:border-primary/60 focus:ring-1 focus:ring-primary/30 focus:outline-none transition-all w-full",
      placeholder: "Confirm new password",
    });

    const errorEl = h("p", {
      className: this.#errorText ? "text-label-micro font-label-technical text-error" : "hidden",
    }, this.#errorText);

    const submitBtn = h("button", {
      type: "submit",
      disabled: this.#busy,
      className: "bg-primary-container text-on-primary-container px-space-md py-2 rounded-lg font-label-technical text-label-technical font-bold hover:bg-primary hover:text-on-primary transition-all cursor-pointer disabled:opacity-50",
    }, this.#busy ? "Resetting..." : "Reset password");
    const cancelBtn = h("button", {
      type: "button",
      className: "bg-surface-container-high border border-outline-variant/40 px-space-md py-2 rounded-lg text-on-surface-variant font-label-technical text-label-technical font-bold hover:border-primary/40 hover:text-on-surface transition-all cursor-pointer",
    }, "Cancel");
    cancelBtn.addEventListener("click", () => this.close());

    const form = h("form", { className: "flex flex-col gap-space-md" }, [
      h("p", { className: "text-body-sm font-body-sm text-on-surface-variant" },
        "Enter your recovery phrase and a new password. Your phrase is never sent anywhere — it stays on this device. After resetting, the vault locks and you unlock with the new password."),
      phraseInput,
      newInput,
      confirmInput,
      errorEl,
      h("div", { className: "flex gap-space-md justify-end" }, [cancelBtn, submitBtn]),
    ]);

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (this.#busy) return;
      const mnemonic = String(phraseInput.value || "").trim().replace(/\s+/g, " ");
      const newPwd = String(newInput.value || "");
      const confirm = String(confirmInput.value || "");
      if (!mnemonic) {
        this.#errorText = "Enter your recovery phrase.";
        this.#rerender();
        return;
      }
      if (newPwd.length < MIN_PASSWORD_LENGTH) {
        this.#errorText = "New password must be at least " + MIN_PASSWORD_LENGTH + " characters.";
        this.#rerender();
        return;
      }
      if (newPwd !== confirm) {
        this.#errorText = "New password and confirmation do not match.";
        this.#rerender();
        return;
      }
      this.#errorText = "";
      this.#busy = true;
      this.#rerender();
      try {
        await this.bus.call("session", "resetPasswordWithMnemonic", {
          accountId: this.#accountId,
          mnemonic,
          newPassword: newPwd,
        });
        this.#busy = false;
        this.#step = "done";
        this.#rerender();
      } catch (err) {
        this.#errorText = (err && err.message) ? err.message : "Could not reset password.";
        this.#busy = false;
        this.#rerender();
      }
    });

    return h("div", { className: "p-space-lg flex flex-col gap-space-md" }, [
      h("h3", { className: "text-headline-sm font-headline-sm text-on-surface" }, "Reset password with recovery phrase"),
      form,
    ]);
  }

  #renderDoneStep() {
    const doneBtn = h("button", {
      type: "button",
      className: "bg-primary-container text-on-primary-container px-space-md py-2 rounded-lg font-label-technical text-label-technical font-bold hover:bg-primary hover:text-on-primary transition-all cursor-pointer",
    }, "Done");
    doneBtn.addEventListener("click", () => this.close());

    return h("div", { className: "p-space-lg flex flex-col gap-space-md" }, [
      h("h3", { className: "text-headline-sm font-headline-sm text-on-surface" }, "Password reset"),
      h("p", { className: "text-body-sm font-body-sm text-on-surface-variant" },
        "Your password has been reset and the vault is now locked. Unlock with your new password to continue."),
      h("div", { className: "flex gap-space-md justify-end" }, [doneBtn]),
    ]);
  }

  #rerender() {
    if (!this._panelEl) return;
    this._panelEl.replaceChildren();
    const content = this.renderContent();
    if (content) this._panelEl.appendChild(content);
  }
}
