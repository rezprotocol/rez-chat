import { h } from "@rezprotocol/ui";
import { ModalView } from "./ModalView.js";
import { shortId } from "../presenters/labels.js";

/**
 * Phase 6 — pre-BIP39 account migration. An account created before recovery
 * phrases existed has no mnemonic, no encrypted backup, and no forgot-password
 * path: it can never be recovered if the password is lost. To enable recovery
 * it must be re-created from scratch, which destroys the old local account.
 *
 * Reaching this modal means the lock screen detected `recoveryEnabled === false`
 * for the selected account and refused to offer an unlock form. The user
 * confirms with their (still-valid) vault password; we reuse the audited
 * `session.purgeAccount` directive — the SAME destructive path as delete-account
 * — to drop the vault row, then the auth refresh routes to account creation
 * (or the remaining accounts). There is NO password-less wipe: an attacker with
 * renderer access still cannot silently nuke the vault.
 */
export class LegacyAccountMigrationModal extends ModalView {
  #accountId;
  #errorText;
  #busy;

  constructor({ bus, accountId } = {}) {
    super({ bus });
    this.#accountId = String(accountId || "");
    this.#errorText = "";
    this.#busy = false;
  }

  renderContent() {
    const accountLabel = this.#accountId ? shortId(this.#accountId, 32) : "";

    const passwordInput = h("input", {
      type: "password",
      autocomplete: "current-password",
      className: "bg-surface-container-high border border-outline-variant/40 rounded-lg px-space-md py-2 text-label-technical font-label-technical text-on-surface placeholder:text-outline-variant focus:border-primary/60 focus:ring-1 focus:ring-primary/30 focus:outline-none transition-all w-full",
      placeholder: "Enter this account's password to confirm",
    });

    const errorEl = h("p", {
      className: this.#errorText ? "text-label-micro font-label-technical text-error" : "hidden",
    }, this.#errorText);

    const submitBtn = h("button", {
      type: "submit",
      disabled: this.#busy,
      className: "bg-error/90 text-on-error px-space-md py-2 rounded-lg font-label-technical text-label-technical font-bold hover:bg-error transition-all cursor-pointer disabled:opacity-50",
    }, this.#busy ? "Deleting..." : "Delete & re-create");
    const cancelBtn = h("button", {
      type: "button",
      className: "bg-surface-container-high border border-outline-variant/40 px-space-md py-2 rounded-lg text-on-surface-variant font-label-technical text-label-technical font-bold hover:border-primary/40 hover:text-on-surface transition-all cursor-pointer",
    }, "Cancel");
    cancelBtn.addEventListener("click", () => this.close());

    const form = h("form", { className: "flex flex-col gap-space-md" }, [
      h("p", { className: "text-body-sm font-body-sm text-on-surface-variant" },
        "Rez now uses recovery phrases so you can never lose access to an account again. This account was created before that and can't be upgraded in place — it must be re-created. Its local data on this device will be deleted, and you'll set up a fresh account with a recovery phrase."),
      accountLabel ? h("p", { className: "text-label-micro font-label-technical text-on-surface-variant/60 break-all" }, "Account " + accountLabel) : null,
      passwordInput,
      errorEl,
      h("div", { className: "flex gap-space-md justify-end" }, [cancelBtn, submitBtn]),
    ]);

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (this.#busy) return;
      const password = String(passwordInput.value || "");
      if (!password) {
        this.#errorText = "Enter this account's password to confirm.";
        this.#rerender();
        return;
      }
      this.#errorText = "";
      this.#busy = true;
      this.#rerender();
      try {
        await this.bus.call("session", "purgeAccount", {
          accountId: this.#accountId,
          password,
        });
        // The account list refresh routes to account creation (or the
        // remaining accounts); nothing left to show here.
        this.close();
      } catch (err) {
        this.#errorText = (err && err.message) ? err.message : "Could not re-create the account.";
        this.#busy = false;
        this.#rerender();
      }
    });

    return h("div", { className: "p-space-lg flex flex-col gap-space-md" }, [
      h("h3", { className: "text-headline-sm font-headline-sm text-on-surface" }, "Re-create this account"),
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
