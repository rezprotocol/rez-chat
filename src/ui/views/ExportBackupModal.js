import { h } from "@rezprotocol/ui";
import { ModalView } from "./ModalView.js";

/**
 * Export an encrypted account backup file. Step 1 confirms the vault password
 * (so we can decrypt the mnemonic + app-data key); step 2 reports the saved
 * path. The vault produces a ciphertext envelope encrypted under the
 * seed-derived backup KEK — the plaintext (mnemonic-derived secrets) never
 * crosses into the renderer. File I/O goes through the main process via
 * window.rezDesktop.backup.saveToFile (native save dialog + fs write).
 */
export class ExportBackupModal extends ModalView {
  #step;
  #errorText;
  #busy;
  #savedPath;

  constructor({ bus } = {}) {
    super({ bus });
    this.#step = "form";
    this.#errorText = "";
    this.#busy = false;
    this.#savedPath = "";
  }

  #desktop() {
    return typeof window !== "undefined" && window.rezDesktop ? window.rezDesktop : null;
  }

  renderContent() {
    if (this.#step === "done") return this.#renderDoneStep();
    return this.#renderFormStep();
  }

  #renderFormStep() {
    const passwordInput = h("input", {
      type: "password",
      autocomplete: "current-password",
      className: "bg-surface-container-high border border-outline-variant/40 rounded-lg px-space-md py-2 text-label-technical font-label-technical text-on-surface placeholder:text-outline-variant focus:border-primary/60 focus:ring-1 focus:ring-primary/30 focus:outline-none transition-all w-full",
      placeholder: "Enter your vault password",
    });

    const errorEl = h("p", {
      className: this.#errorText ? "text-label-micro font-label-technical text-error" : "hidden",
    }, this.#errorText);

    const submitBtn = h("button", {
      type: "submit",
      disabled: this.#busy,
      className: "bg-primary-container text-on-primary-container px-space-md py-2 rounded-lg font-label-technical text-label-technical font-bold hover:bg-primary hover:text-on-primary transition-all cursor-pointer disabled:opacity-50",
    }, this.#busy ? "Exporting..." : "Export backup");
    const cancelBtn = h("button", {
      type: "button",
      className: "bg-surface-container-high border border-outline-variant/40 px-space-md py-2 rounded-lg text-on-surface-variant font-label-technical text-label-technical font-bold hover:border-primary/40 hover:text-on-surface transition-all cursor-pointer",
    }, "Cancel");
    cancelBtn.addEventListener("click", () => this.close());

    const form = h("form", { className: "flex flex-col gap-space-md" }, [
      h("p", { className: "text-body-sm font-body-sm text-on-surface-variant" },
        "Saves an encrypted backup of this account. The file is locked with your recovery phrase: restoring it on another device requires the 24 words. Keep it somewhere safe."),
      passwordInput,
      errorEl,
      h("div", { className: "flex gap-space-md justify-end" }, [cancelBtn, submitBtn]),
    ]);

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (this.#busy) return;
      const password = String(passwordInput.value || "");
      if (!password) {
        this.#errorText = "Enter your vault password.";
        this.#rerender();
        return;
      }
      const desktop = this.#desktop();
      if (!desktop || !desktop.backup || typeof desktop.backup.saveToFile !== "function") {
        this.#errorText = "Backup export is only available in the desktop app.";
        this.#rerender();
        return;
      }
      this.#errorText = "";
      this.#busy = true;
      this.#rerender();
      try {
        const envelope = await this.bus.call("session", "exportBackup", { password });
        const suggestedName = "rez-backup-" + (envelope && envelope.accountId ? envelope.accountId : "account") + ".json";
        const res = await desktop.backup.saveToFile({ envelope, suggestedName });
        if (res && res.canceled === true) {
          // User dismissed the native save dialog; stay on the form.
          this.#busy = false;
          this.#rerender();
          return;
        }
        this.#busy = false;
        this.#savedPath = res && res.filePath ? String(res.filePath) : "";
        this.#step = "done";
        this.#rerender();
      } catch (err) {
        this.#errorText = (err && err.message) ? err.message : "Could not export backup.";
        this.#busy = false;
        this.#rerender();
      }
    });

    return h("div", { className: "p-space-lg flex flex-col gap-space-md" }, [
      h("h3", { className: "text-headline-sm font-headline-sm text-on-surface" }, "Export encrypted backup"),
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
      h("h3", { className: "text-headline-sm font-headline-sm text-on-surface" }, "Backup saved"),
      h("p", { className: "text-body-sm font-body-sm text-on-surface-variant" },
        "Your encrypted backup was saved. You can restore it on any device with this file and your 24-word recovery phrase."),
      this.#savedPath ? h("p", { className: "text-label-micro font-label-technical text-on-surface-variant/60 break-all" }, this.#savedPath) : null,
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
