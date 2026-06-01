import { h } from "@rezprotocol/ui";
import { ModalView } from "./ModalView.js";

const MIN_PASSWORD_LENGTH = 8;

/**
 * Change-password modal. Three inputs: old password, new password, confirm
 * new password. Submits via `session.changePassword` and surfaces the
 * vault's error message verbatim on failure (e.g., "matches old password",
 * "decryption integrity check failed", etc.).
 *
 * On success the vault auto-locks and the supervisor disconnects runtime,
 * so the UI returns to the login screen — this modal's job is just to
 * collect the inputs and close.
 */
export class ChangePasswordModal extends ModalView {
  #errorText;
  #busy;

  constructor({ bus } = {}) {
    super({ bus });
    this.#errorText = "";
    this.#busy = false;
  }

  renderContent() {
    const oldInput = h("input", {
      type: "password",
      autocomplete: "current-password",
      className: "bg-surface-container-high border border-outline-variant/40 rounded-lg px-space-md py-2 text-label-technical font-label-technical text-on-surface placeholder:text-outline-variant focus:border-primary/60 focus:ring-1 focus:ring-primary/30 focus:outline-none transition-all w-full",
      placeholder: "Current password",
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
    }, this.#busy ? "Changing..." : "Change password");
    const cancelBtn = h("button", {
      type: "button",
      className: "bg-surface-container-high border border-outline-variant/40 px-space-md py-2 rounded-lg text-on-surface-variant font-label-technical text-label-technical font-bold hover:border-primary/40 hover:text-on-surface transition-all cursor-pointer",
    }, "Cancel");
    cancelBtn.addEventListener("click", () => this.close());

    const form = h("form", { className: "flex flex-col gap-space-md" }, [
      h("p", { className: "text-body-sm font-body-sm text-on-surface-variant" },
        "After changing your password, the app will lock. Unlock with your new password to continue."),
      oldInput,
      newInput,
      confirmInput,
      errorEl,
      h("div", { className: "flex gap-space-md justify-end" }, [cancelBtn, submitBtn]),
    ]);

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (this.#busy) return;
      const oldPwd = String(oldInput.value || "");
      const newPwd = String(newInput.value || "");
      const confirm = String(confirmInput.value || "");
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
        await this.bus.call("session", "changePassword", { oldPassword: oldPwd, newPassword: newPwd });
        this.close();
      } catch (err) {
        this.#errorText = (err && err.message) ? err.message : "Could not change password.";
        this.#busy = false;
        this.#rerender();
      }
    });

    return h("div", { className: "p-space-lg flex flex-col gap-space-md" }, [
      h("h3", { className: "text-headline-sm font-headline-sm text-on-surface" }, "Change password"),
      form,
    ]);
  }

  #rerender() {
    if (!this._panelEl) return;
    this._panelEl.replaceChildren();
    const content = this.renderContent();
    if (content) this._panelEl.appendChild(content);
  }
}
