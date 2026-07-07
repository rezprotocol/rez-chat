import { h } from "@rezprotocol/ui";
import { materialIcon } from "../base/icon.js";
import { ModalView } from "./ModalView.js";

/**
 * DeviceLinkModal (S2.5 S10, PRIMARY side) — shows the one-time link code and,
 * once the new device requests, its fingerprint for the human cross-check
 * before Approve. Progress is driven by the `deviceLink.updated` bus event.
 * Plain-text code + copy button (no QR — mobile/QR is a later slice).
 */
export class DeviceLinkModal extends ModalView {
  #state;
  #linkCode;
  #expiresAtMs;
  #pending; // { newDeviceId, fingerprint }
  #message;
  #off;
  #started;

  constructor({ bus } = {}) {
    super({ bus });
    this.#state = "starting";
    this.#linkCode = "";
    this.#expiresAtMs = 0;
    this.#pending = null;
    this.#message = "";
    this.#off = null;
    this.#started = false;
  }

  open() {
    super.open();
    this.#off = this.bus.on("deviceLink.updated", (record) => this.#onUpdated(record));
    if (!this.#started) {
      this.#started = true;
      this.bus.call("deviceLink", "start").then((res) => {
        this.#linkCode = res && res.linkCode ? String(res.linkCode) : "";
        this.#expiresAtMs = res && res.expiresAtMs ? Number(res.expiresAtMs) : 0;
        this.#state = "code-issued";
        this.#rerender();
      }).catch((err) => {
        this.#state = "failed";
        this.#message = err && err.message ? err.message : "Could not start device linking.";
        this.#rerender();
      });
    }
  }

  close() {
    if (this.#off) { this.#off(); this.#off = null; }
    // Veto anything still in flight when the user dismisses.
    if (this.#state === "code-issued" || this.#state === "pending") {
      this.bus.call("deviceLink", "cancel").catch(() => {});
    }
    super.close();
  }

  #onUpdated(record) {
    const r = record && typeof record.toJSON === "function" ? record.toJSON() : record;
    if (!r || typeof r !== "object") return;
    this.#state = String(r.state || this.#state);
    if (r.newDeviceId || r.fingerprint) {
      this.#pending = { newDeviceId: r.newDeviceId || "", fingerprint: r.fingerprint || "" };
    }
    if (r.message) this.#message = String(r.message);
    this.#rerender();
  }

  #rerender() {
    if (!this._panelEl) return;
    this._panelEl.replaceChildren(this.renderContent());
  }

  #copyButton() {
    const code = this.#linkCode;
    const btn = h("button", {
      type: "button",
      className: "shrink-0 bg-primary-container text-on-primary-container px-space-md py-2 rounded font-label-technical text-label-technical font-bold hover:bg-primary hover:text-on-primary transition-all cursor-pointer flex items-center gap-space-sm",
      "data-testid": "device-link.modal.copy",
    }, [materialIcon("content_copy", { size: 14 }), document.createTextNode("Copy")]);
    btn.addEventListener("click", () => {
      if (!code) return;
      const restore = () => btn.replaceChildren(materialIcon("content_copy", { size: 14 }), document.createTextNode("Copy"));
      const flash = () => {
        btn.replaceChildren(materialIcon("check", { size: 14 }), document.createTextNode("Copied"));
        setTimeout(restore, 1500);
      };
      if (navigator && navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
        navigator.clipboard.writeText(code).then(flash).catch(() => flash());
      } else {
        flash();
      }
    });
    return btn;
  }

  renderContent() {
    const title = h("h3", { className: "text-headline-sm font-headline-sm text-on-surface" }, "Link a new device");
    const rows = [title];

    if (this.#state === "starting") {
      rows.push(h("p", { className: "text-body-sm font-body-sm text-on-surface-variant/70" }, "Preparing a one-time link code…"));
    } else if (this.#state === "code-issued" || this.#state === "pending" && !this.#pending) {
      rows.push(h("p", { className: "text-body-sm font-body-sm text-on-surface-variant/70" },
        "On your new device, choose “Link this device” and paste this one-time code. It expires in a few minutes."));
      rows.push(h("div", { className: "flex items-center gap-space-sm" }, [
        h("p", {
          className: "flex-1 font-label-technical text-label-technical text-primary break-all bg-surface-container-lowest border border-primary/30 rounded px-space-md py-2.5 select-all",
          "data-testid": "device-link.modal.code",
        }, this.#linkCode || "(no code)"),
        this.#copyButton(),
      ]));
    }

    if (this.#state === "pending" && this.#pending) {
      rows.push(h("p", { className: "text-body-sm font-body-sm text-on-surface-variant/70" },
        "A device is requesting to link. Confirm the fingerprint below MATCHES the one shown on that device before approving."));
      rows.push(h("p", {
        className: "font-label-technical text-headline-sm text-primary text-center tracking-wider bg-surface-container-lowest border border-primary/30 rounded px-space-md py-3 select-all",
        "data-testid": "device-link.modal.fingerprint",
      }, this.#pending.fingerprint || "(no fingerprint)"));
      const approve = h("button", {
        type: "button",
        className: "flex-1 bg-primary text-on-primary px-space-lg py-2 rounded font-label-technical text-label-technical font-bold hover:bg-primary/90 transition-all cursor-pointer",
        "data-testid": "device-link.modal.approve",
      }, "Approve");
      approve.addEventListener("click", () => {
        this.bus.call("deviceLink", "approve", { newDeviceId: this.#pending.newDeviceId }).catch((err) => {
          this.#state = "failed";
          this.#message = err && err.message ? err.message : "Approve failed.";
          this.#rerender();
        });
      });
      const deny = h("button", {
        type: "button",
        className: "flex-1 bg-surface-container border border-outline-variant/40 text-on-surface-variant px-space-lg py-2 rounded font-label-technical text-label-technical font-bold hover:border-error/40 hover:text-error transition-all cursor-pointer",
        "data-testid": "device-link.modal.deny",
      }, "Deny");
      deny.addEventListener("click", () => this.close());
      rows.push(h("div", { className: "flex gap-space-sm pt-space-sm" }, [deny, approve]));
    }

    if (this.#state === "responding") {
      rows.push(h("p", { className: "text-body-sm font-body-sm text-on-surface-variant/70" }, "Provisioning the new device…"));
    }
    if (this.#state === "confirmed") {
      rows.push(h("p", { className: "text-body-sm font-body-sm text-primary", "data-testid": "device-link.modal.done" }, "Device linked successfully."));
    }
    if (this.#state === "cancelled" || this.#state === "expired" || this.#state === "failed") {
      const label = this.#state === "expired" ? "The link code expired." : this.#state === "cancelled" ? "Device linking cancelled." : "Device linking failed.";
      rows.push(h("p", { className: "text-body-sm font-body-sm text-error", "data-testid": "device-link.modal.error" }, this.#message || label));
    }

    const closeLabel = (this.#state === "confirmed" || this.#state === "cancelled" || this.#state === "expired" || this.#state === "failed") ? "Done" : "Cancel";
    const closeBtn = h("button", {
      type: "button",
      className: "bg-surface-container border border-outline-variant/40 text-on-surface-variant px-space-lg py-2 rounded font-label-technical text-label-technical font-bold hover:border-primary/40 hover:text-primary transition-all cursor-pointer",
      "data-testid": "device-link.modal.close",
    }, closeLabel);
    closeBtn.addEventListener("click", () => this.close());
    rows.push(h("div", { className: "flex justify-end pt-space-sm" }, [closeBtn]));

    return h("div", { className: "p-space-lg flex flex-col gap-space-md" }, rows);
  }
}
