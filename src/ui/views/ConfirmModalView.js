import { h } from "rez-ui";
import { ModalView } from "./ModalView.js";
import { materialIcon } from "../base/icon.js";

/**
 * Confirm/cancel modal dialog.
 *
 * Usage:
 *   const modal = new ConfirmModalView({
 *     bus,
 *     title: "Delete contact",
 *     message: "Are you sure you want to delete this contact? This cannot be undone.",
 *     confirmLabel: "Delete",
 *     cancelLabel: "Cancel",
 *     variant: "danger",   // "danger" | "default"
 *     onConfirm: () => { ... },
 *     onCancel: () => { ... },   // optional, defaults to close
 *   });
 *   modal.open();
 */
export class ConfirmModalView extends ModalView {
  #title;
  #message;
  #confirmLabel;
  #cancelLabel;
  #variant;
  #onConfirm;
  #onCancel;

  constructor({ bus, title, message, confirmLabel, cancelLabel, variant, onConfirm, onCancel } = {}) {
    super({ bus });
    this.#title = title || "Confirm";
    this.#message = message || "";
    this.#confirmLabel = confirmLabel || "Confirm";
    this.#cancelLabel = cancelLabel || "Cancel";
    this.#variant = variant || "default";
    this.#onConfirm = typeof onConfirm === "function" ? onConfirm : () => {};
    this.#onCancel = typeof onCancel === "function" ? onCancel : null;
  }

  renderContent() {
    const isDanger = this.#variant === "danger";

    const iconEl = isDanger
      ? h("div", { className: "w-10 h-10 rounded-full bg-error/15 flex items-center justify-center shrink-0" }, [
          materialIcon("warning", { size: 20, className: "text-error" }),
        ])
      : h("div", { className: "w-10 h-10 rounded-full bg-primary/15 flex items-center justify-center shrink-0" }, [
          materialIcon("help", { size: 20, className: "text-primary" }),
        ]);

    const confirmBtnClass = isDanger
      ? "bg-error/15 border border-error/50 px-space-md py-2.5 rounded-lg text-error font-label-technical text-label-technical font-bold hover:bg-error hover:text-on-error transition-all cursor-pointer flex-1"
      : "bg-primary-container text-on-primary-container border border-primary/40 px-space-md py-2.5 rounded-lg font-label-technical text-label-technical font-bold hover:bg-primary hover:text-on-primary transition-all cursor-pointer flex-1";

    const confirmBtn = h("button", { type: "button", className: confirmBtnClass }, this.#confirmLabel);
    const cancelBtn = h("button", {
      type: "button",
      className: "bg-surface-container-high border border-outline-variant/40 px-space-md py-2.5 rounded-lg text-on-surface-variant font-label-technical text-label-technical font-bold hover:border-primary/40 hover:text-on-surface transition-all cursor-pointer flex-1",
    }, this.#cancelLabel);

    confirmBtn.addEventListener("click", () => {
      this.#onConfirm();
      this.close();
    });
    cancelBtn.addEventListener("click", () => this._onDismiss());

    return h("div", { className: "p-space-lg flex flex-col gap-space-lg" }, [
      h("div", { className: "flex items-start gap-space-md" }, [
        iconEl,
        h("div", { className: "flex flex-col gap-space-sm flex-1" }, [
          h("h3", { className: "text-headline-sm font-headline-sm text-on-surface" }, this.#title),
          this.#message
            ? h("p", { className: "text-body-sm font-body-sm text-on-surface-variant leading-relaxed" }, this.#message)
            : null,
        ]),
      ]),
      h("div", { className: "flex gap-space-md" }, [cancelBtn, confirmBtn]),
    ]);
  }

  _onDismiss() {
    if (this.#onCancel) {
      this.#onCancel();
    }
    this.close();
  }
}
