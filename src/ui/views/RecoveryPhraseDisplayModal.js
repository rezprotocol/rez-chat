import { h } from "@rezprotocol/ui";
import { ModalView } from "./ModalView.js";

const ACK_COUNTDOWN_SECONDS = 5;

/**
 * Two-step "show your recovery phrase" modal.
 *
 * Step 1 — Password prompt. User types the vault password; on submit we ask
 * the session bus for the mnemonic (`session.revealMnemonic`).
 * Step 2 — Phrase display in a 6×4 grid. The "I've written this down" button
 * is disabled for 5 seconds to force a moment of attention.
 *
 * No copy-to-clipboard button: the phrase is the root of the user's account
 * and must be transcribed by hand. The clipboard is a leak surface (other
 * apps can read it; iOS/macOS sync it across devices). Print is the only
 * one-click export, and that goes through window.print() against a print
 * stylesheet so screen capture is the only digital path.
 */
export class RecoveryPhraseDisplayModal extends ModalView {
  #step;
  #mnemonic;
  #errorText;
  #busy;
  #ackSecondsRemaining;
  #ackTimer;

  constructor({ bus, initialMnemonic } = {}) {
    super({ bus });
    // When seeded with a mnemonic (post-account-creation confirmation), skip
    // the password step and show the phrase directly. Otherwise start at the
    // password prompt and reveal via `session.revealMnemonic`.
    const seed = String(initialMnemonic || "").trim();
    this.#mnemonic = seed;
    this.#step = seed ? "phrase" : "password";
    this.#errorText = "";
    this.#busy = false;
    this.#ackSecondsRemaining = ACK_COUNTDOWN_SECONDS;
    this.#ackTimer = null;
  }

  open() {
    super.open();
    // The password-step path starts the countdown from its submit handler; the
    // seeded path has no submit, so kick it off once the panel is mounted.
    if (this.#step === "phrase") this.#startAckCountdown();
  }

  renderContent() {
    if (this.#step === "password") return this.#renderPasswordStep();
    if (this.#step === "phrase") return this.#renderPhraseStep();
    return h("div", { className: "p-space-lg" }, "");
  }

  #renderPasswordStep() {
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
    }, this.#busy ? "Revealing..." : "Reveal");
    const cancelBtn = h("button", {
      type: "button",
      className: "bg-surface-container-high border border-outline-variant/40 px-space-md py-2 rounded-lg text-on-surface-variant font-label-technical text-label-technical font-bold hover:border-primary/40 hover:text-on-surface transition-all cursor-pointer",
    }, "Cancel");
    cancelBtn.addEventListener("click", () => this.close());

    const form = h("form", { className: "flex flex-col gap-space-md" }, [
      h("p", { className: "text-body-sm font-body-sm text-on-surface-variant" },
        "Your 24-word recovery phrase will be shown next. Anyone with this phrase can recover your account on any device — keep it offline and private."),
      passwordInput,
      errorEl,
      h("div", { className: "flex gap-space-md justify-end" }, [cancelBtn, submitBtn]),
    ]);

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (this.#busy) return;
      // Capture the value before #rerender() detaches this input node.
      const password = passwordInput.value;
      this.#busy = true;
      this.#errorText = "";
      this.#rerender();
      try {
        const result = await this.bus.call("session", "revealMnemonic", { password });
        const phrase = result && typeof result.mnemonic === "string" ? result.mnemonic : "";
        if (!phrase) throw new Error("Vault returned an empty recovery phrase.");
        this.#mnemonic = phrase;
        this.#step = "phrase";
        this.#busy = false;
        this.#rerender();
        this.#startAckCountdown();
      } catch (err) {
        this.#errorText = (err && err.message) ? err.message : "Could not reveal recovery phrase.";
        this.#busy = false;
        this.#rerender();
      }
    });

    return h("div", { className: "p-space-lg flex flex-col gap-space-md" }, [
      h("h3", { className: "text-headline-sm font-headline-sm text-on-surface" }, "Show recovery phrase"),
      form,
    ]);
  }

  #renderPhraseStep() {
    const words = this.#mnemonic.split(" ");
    const grid = h("div", { className: "grid grid-cols-3 gap-x-space-md gap-y-2 font-mono text-label-technical select-text" }, words.map((word, i) => (
      h("div", { className: "flex items-baseline gap-space-sm bg-surface-container-high border border-outline-variant/30 rounded px-space-sm py-1.5" }, [
        h("span", { className: "text-label-micro font-label-technical text-outline w-6 text-right shrink-0" }, String(i + 1) + "."),
        h("span", { className: "text-on-surface" }, word),
      ])
    )));

    const ackBtn = h("button", {
      type: "button",
      "data-role": "ack",
      disabled: true,
      className: "bg-primary-container text-on-primary-container px-space-md py-2 rounded-lg font-label-technical text-label-technical font-bold hover:bg-primary hover:text-on-primary transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed",
    }, "I've written it down (" + this.#ackSecondsRemaining + "s)");
    ackBtn.addEventListener("click", () => this.close());

    const printBtn = h("button", {
      type: "button",
      className: "bg-surface-container-high border border-outline-variant/40 px-space-md py-2 rounded-lg text-on-surface-variant font-label-technical text-label-technical font-bold hover:border-primary/40 hover:text-on-surface transition-all cursor-pointer",
    }, "Print");
    printBtn.addEventListener("click", () => {
      if (typeof window !== "undefined" && typeof window.print === "function") window.print();
    });

    return h("div", { className: "p-space-lg flex flex-col gap-space-md" }, [
      h("h3", { className: "text-headline-sm font-headline-sm text-on-surface" }, "Your recovery phrase"),
      h("p", { className: "text-body-sm font-body-sm text-on-surface-variant" },
        "Write these 24 words down in order and store them somewhere safe. They restore your account on any device. Lose them and the account is unrecoverable."),
      grid,
      h("div", { className: "flex gap-space-md justify-end" }, [printBtn, ackBtn]),
    ]);
  }

  #startAckCountdown() {
    if (this.#ackTimer) clearInterval(this.#ackTimer);
    this.#ackSecondsRemaining = ACK_COUNTDOWN_SECONDS;
    this.#ackTimer = setInterval(() => {
      this.#ackSecondsRemaining -= 1;
      if (this.#ackSecondsRemaining <= 0) {
        clearInterval(this.#ackTimer);
        this.#ackTimer = null;
      }
      this.#rerender();
    }, 1000);
  }

  #rerender() {
    if (!this._panelEl) return;
    this._panelEl.replaceChildren();
    const content = this.renderContent();
    if (content) this._panelEl.appendChild(content);
    if (this.#step === "phrase" && this.#ackSecondsRemaining <= 0) {
      const btn = this._panelEl.querySelector("button[data-role='ack']");
      if (btn) {
        btn.disabled = false;
        btn.textContent = "I've written it down";
      }
    }
  }

  close() {
    if (this.#ackTimer) {
      clearInterval(this.#ackTimer);
      this.#ackTimer = null;
    }
    this.#mnemonic = "";
    super.close();
  }
}
