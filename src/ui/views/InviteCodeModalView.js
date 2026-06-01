import { h } from "@rezprotocol/ui";
import { materialIcon } from "../base/icon.js";
import { ModalView } from "./ModalView.js";

export class InviteCodeModalView extends ModalView {
  #inviteCode;
  #title;
  #subtitle;

  constructor({ bus, inviteCode, title = "Invite code", subtitle = "" } = {}) {
    super({ bus });
    this.#inviteCode = String(inviteCode || "").trim();
    this.#title = String(title || "Invite code");
    this.#subtitle = String(subtitle || "");
  }

  renderContent() {
    const code = this.#inviteCode;
    const copyBtn = h("button", {
      type: "button",
      className: "shrink-0 bg-primary-container text-on-primary-container px-space-md py-2 rounded font-label-technical text-label-technical font-bold hover:bg-primary hover:text-on-primary transition-all cursor-pointer flex items-center gap-space-sm",
      "data-testid": "invite.code.modal.copy",
    }, [materialIcon("content_copy", { size: 14 }), document.createTextNode("Copy")]);
    copyBtn.addEventListener("click", () => {
      if (!code) return;
      const restore = () => {
        copyBtn.replaceChildren(materialIcon("content_copy", { size: 14 }), document.createTextNode("Copy"));
      };
      const flashCopied = () => {
        copyBtn.replaceChildren(materialIcon("check", { size: 14 }), document.createTextNode("Copied"));
        setTimeout(restore, 1500);
      };
      if (navigator && navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
        navigator.clipboard.writeText(code).then(flashCopied).catch((err) => {
          console.error("[InviteCodeModalView] clipboard write failed", err);
          this.bus.emit("app.error", { source: "InviteCodeModalView", message: "clipboard write failed", severity: "warn", err });
        });
      } else {
        flashCopied();
      }
    });

    const closeBtn = h("button", {
      type: "button",
      className: "bg-surface-container border border-outline-variant/40 text-on-surface-variant px-space-lg py-2 rounded font-label-technical text-label-technical font-bold hover:border-primary/40 hover:text-primary transition-all cursor-pointer",
      "data-testid": "invite.code.modal.close",
    }, "Done");
    closeBtn.addEventListener("click", () => this.close());

    return h("div", { className: "p-space-lg flex flex-col gap-space-md" }, [
      h("h3", { className: "text-headline-sm font-headline-sm text-on-surface" }, this.#title),
      this.#subtitle
        ? h("p", { className: "text-body-sm font-body-sm text-on-surface-variant/70" }, this.#subtitle)
        : null,
      h("div", { className: "flex items-center gap-space-sm" }, [
        h("p", {
          className: "flex-1 font-label-technical text-label-technical text-primary break-all bg-surface-container-lowest border border-primary/30 rounded px-space-md py-2.5 select-all",
          "data-testid": "invite.code.modal.code",
        }, code || "(no invite code returned)"),
        copyBtn,
      ]),
      h("div", { className: "flex justify-end pt-space-sm" }, [closeBtn]),
    ]);
  }
}
