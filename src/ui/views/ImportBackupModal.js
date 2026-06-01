import { h } from "@rezprotocol/ui";
import { ModalView } from "./ModalView.js";
import { shortId } from "../presenters/labels.js";

/**
 * Restore an account from an encrypted backup file on the lock screen. Step 1
 * picks the file (native open dialog via window.rezDesktop.backup.openFile);
 * step 2 collects the 24-word recovery phrase (which decrypts the file) plus a
 * new vault password. On success the session lands UNLOCKED as the restored
 * account and the scene switches to the main app.
 */
export class ImportBackupModal extends ModalView {
  #step;
  #envelope;
  #errorText;
  #busy;

  constructor({ bus } = {}) {
    super({ bus });
    this.#step = "pick";
    this.#envelope = null;
    this.#errorText = "";
    this.#busy = false;
  }

  #desktop() {
    return typeof window !== "undefined" && window.rezDesktop ? window.rezDesktop : null;
  }

  renderContent() {
    if (this.#step === "form") return this.#renderFormStep();
    return this.#renderPickStep();
  }

  #renderPickStep() {
    const errorEl = h("p", {
      className: this.#errorText ? "text-label-micro font-label-technical text-error" : "hidden",
    }, this.#errorText);

    const chooseBtn = h("button", {
      type: "button",
      disabled: this.#busy,
      className: "bg-primary-container text-on-primary-container px-space-md py-2 rounded-lg font-label-technical text-label-technical font-bold hover:bg-primary hover:text-on-primary transition-all cursor-pointer disabled:opacity-50",
    }, this.#busy ? "Opening..." : "Choose backup file");
    const cancelBtn = h("button", {
      type: "button",
      className: "bg-surface-container-high border border-outline-variant/40 px-space-md py-2 rounded-lg text-on-surface-variant font-label-technical text-label-technical font-bold hover:border-primary/40 hover:text-on-surface transition-all cursor-pointer",
    }, "Cancel");
    cancelBtn.addEventListener("click", () => this.close());

    chooseBtn.addEventListener("click", async () => {
      if (this.#busy) return;
      const desktop = this.#desktop();
      if (!desktop || !desktop.backup || typeof desktop.backup.openFile !== "function") {
        this.#errorText = "Backup restore is only available in the desktop app.";
        this.#rerender();
        return;
      }
      this.#errorText = "";
      this.#busy = true;
      this.#rerender();
      try {
        const res = await desktop.backup.openFile();
        if (res && res.canceled === true) {
          this.#busy = false;
          this.#rerender();
          return;
        }
        const envelope = res && res.envelope ? res.envelope : null;
        if (!envelope || envelope.type !== "rez-backup") {
          throw new Error("That file is not a Rez backup.");
        }
        this.#envelope = envelope;
        this.#busy = false;
        this.#step = "form";
        this.#rerender();
      } catch (err) {
        this.#errorText = (err && err.message) ? err.message : "Could not open backup file.";
        this.#busy = false;
        this.#rerender();
      }
    });

    return h("div", { className: "p-space-lg flex flex-col gap-space-md" }, [
      h("h3", { className: "text-headline-sm font-headline-sm text-on-surface" }, "Restore from backup"),
      h("p", { className: "text-body-sm font-body-sm text-on-surface-variant" },
        "Choose an encrypted Rez backup file. You'll need the 24-word recovery phrase for that account to decrypt it."),
      errorEl,
      h("div", { className: "flex gap-space-md justify-end" }, [cancelBtn, chooseBtn]),
    ]);
  }

  #renderFormStep() {
    const accountLabel = this.#envelope && this.#envelope.accountId ? shortId(this.#envelope.accountId, 32) : "";

    const phraseInput = h("textarea", {
      rows: "3",
      autocomplete: "off",
      autocorrect: "off",
      autocapitalize: "off",
      spellcheck: "false",
      className: "bg-surface-container-high border border-outline-variant/40 rounded-lg px-space-md py-2 text-label-technical font-label-technical text-on-surface placeholder:text-outline-variant focus:border-primary/60 focus:ring-1 focus:ring-primary/30 focus:outline-none transition-all w-full resize-none",
      placeholder: "Enter the 24-word recovery phrase, words separated by spaces",
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
    }, this.#busy ? "Restoring..." : "Restore account");
    const cancelBtn = h("button", {
      type: "button",
      className: "bg-surface-container-high border border-outline-variant/40 px-space-md py-2 rounded-lg text-on-surface-variant font-label-technical text-label-technical font-bold hover:border-primary/40 hover:text-on-surface transition-all cursor-pointer",
    }, "Cancel");
    cancelBtn.addEventListener("click", () => this.close());

    const form = h("form", { className: "flex flex-col gap-space-md" }, [
      accountLabel ? h("p", { className: "text-label-micro font-label-technical text-on-surface-variant/60 break-all" }, "Account " + accountLabel) : null,
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
        this.#errorText = "Enter the recovery phrase.";
        this.#rerender();
        return;
      }
      if (newPwd.length < 8) {
        this.#errorText = "New password must be at least 8 characters.";
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
        await this.bus.call("session", "importBackup", {
          encryptedBackup: this.#envelope,
          mnemonic,
          newPassword: newPwd,
        });
        // Session is now UNLOCKED; the scene switches to the main app.
        this.close();
      } catch (err) {
        this.#errorText = (err && err.message) ? err.message : "Could not restore backup.";
        this.#busy = false;
        this.#rerender();
      }
    });

    return h("div", { className: "p-space-lg flex flex-col gap-space-md" }, [
      h("h3", { className: "text-headline-sm font-headline-sm text-on-surface" }, "Restore from backup"),
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
