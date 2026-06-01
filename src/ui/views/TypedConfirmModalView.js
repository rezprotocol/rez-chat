import { h } from "@rezprotocol/ui";
import { ModalView } from "./ModalView.js";
import { materialIcon } from "../base/icon.js";

/**
 * Destructive-action confirmation modal that requires the user to type a
 * specific string (their display name, the word "DELETE", etc.) before the
 * destructive button enables. Used for delete-account; reusable for future
 * irreversible operations.
 *
 * The required input is also where we collect the vault password — same
 * modal collects the typed confirmation AND the password, so the caller can
 * pass both to a single backend call.
 *
 * Usage:
 *   new TypedConfirmModalView({
 *     bus,
 *     title: "Delete account",
 *     message: "...explanation...",
 *     requiredText: "Ada Lovelace",            // user must type this
 *     requiredTextLabel: 'Type "Ada Lovelace" to confirm',
 *     passwordPlaceholder: "Your vault password",
 *     confirmLabel: "Delete account",
 *     onConfirm: async ({ password }) => { ... },
 *   }).open();
 */
export class TypedConfirmModalView extends ModalView {
  #title;
  #message;
  #requiredText;
  #requiredTextLabel;
  #passwordPlaceholder;
  #confirmLabel;
  #cancelLabel;
  #onConfirm;
  #errorText;
  #busy;

  constructor({
    bus,
    title,
    message,
    requiredText,
    requiredTextLabel,
    passwordPlaceholder,
    confirmLabel,
    cancelLabel,
    onConfirm,
  } = {}) {
    super({ bus });
    this.#title = title || "Confirm";
    this.#message = message || "";
    this.#requiredText = String(requiredText || "");
    this.#requiredTextLabel = requiredTextLabel || `Type "${this.#requiredText}" to confirm`;
    this.#passwordPlaceholder = passwordPlaceholder || "Password";
    this.#confirmLabel = confirmLabel || "Confirm";
    this.#cancelLabel = cancelLabel || "Cancel";
    this.#onConfirm = typeof onConfirm === "function" ? onConfirm : async () => {};
    this.#errorText = "";
    this.#busy = false;
  }

  renderContent() {
    const iconEl = h("div", { className: "w-10 h-10 rounded-full bg-error/15 flex items-center justify-center shrink-0" }, [
      materialIcon("warning", { size: 20, className: "text-error" }),
    ]);

    const typedInput = h("input", {
      type: "text",
      autocomplete: "off",
      autocorrect: "off",
      spellcheck: "false",
      className: "bg-surface-container-high border border-outline-variant/40 rounded-lg px-space-md py-2 text-label-technical font-label-technical text-on-surface placeholder:text-outline-variant focus:border-error/60 focus:ring-1 focus:ring-error/30 focus:outline-none transition-all w-full",
      placeholder: this.#requiredTextLabel,
    });

    const passwordInput = h("input", {
      type: "password",
      autocomplete: "current-password",
      className: "bg-surface-container-high border border-outline-variant/40 rounded-lg px-space-md py-2 text-label-technical font-label-technical text-on-surface placeholder:text-outline-variant focus:border-error/60 focus:ring-1 focus:ring-error/30 focus:outline-none transition-all w-full",
      placeholder: this.#passwordPlaceholder,
    });

    const confirmBtn = h("button", {
      type: "submit",
      disabled: true,
      className: "bg-error/15 border border-error/50 px-space-md py-2 rounded-lg text-error font-label-technical text-label-technical font-bold hover:bg-error hover:text-on-error transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed",
    }, this.#confirmLabel);
    const cancelBtn = h("button", {
      type: "button",
      className: "bg-surface-container-high border border-outline-variant/40 px-space-md py-2 rounded-lg text-on-surface-variant font-label-technical text-label-technical font-bold hover:border-primary/40 hover:text-on-surface transition-all cursor-pointer",
    }, this.#cancelLabel);
    cancelBtn.addEventListener("click", () => this.close());

    const refreshConfirmState = () => {
      const textMatches = String(typedInput.value || "") === this.#requiredText;
      const passwordPresent = String(passwordInput.value || "").length > 0;
      confirmBtn.disabled = !(textMatches && passwordPresent) || this.#busy;
    };
    typedInput.addEventListener("input", refreshConfirmState);
    passwordInput.addEventListener("input", refreshConfirmState);

    const errorEl = h("p", {
      className: this.#errorText ? "text-label-micro font-label-technical text-error" : "hidden",
    }, this.#errorText);

    const form = h("form", { className: "flex flex-col gap-space-md flex-1" }, [
      typedInput,
      passwordInput,
      errorEl,
      h("div", { className: "flex gap-space-md justify-end" }, [cancelBtn, confirmBtn]),
    ]);

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (confirmBtn.disabled || this.#busy) return;
      this.#busy = true;
      confirmBtn.disabled = true;
      confirmBtn.textContent = "Working...";
      this.#errorText = "";
      try {
        await this.#onConfirm({ password: String(passwordInput.value || "") });
        this.close();
      } catch (err) {
        this.#errorText = (err && err.message) ? err.message : "Action failed.";
        this.#busy = false;
        confirmBtn.disabled = false;
        confirmBtn.textContent = this.#confirmLabel;
        this.#rerender();
      }
    });

    return h("div", { className: "p-space-lg flex flex-col gap-space-md" }, [
      h("div", { className: "flex items-start gap-space-md" }, [
        iconEl,
        h("div", { className: "flex flex-col gap-space-sm flex-1" }, [
          h("h3", { className: "text-headline-sm font-headline-sm text-on-surface" }, this.#title),
          this.#message
            ? h("p", { className: "text-body-sm font-body-sm text-on-surface-variant leading-relaxed" }, this.#message)
            : null,
        ]),
      ]),
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
