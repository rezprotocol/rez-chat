import { h } from "rez-ui";
import { BusComponent } from "../base/BusComponent.js";

/**
 * Base modal view. Renders a fixed overlay with backdrop + centered content panel.
 * Subclasses override `renderContent()` to fill the panel.
 *
 * Handles:
 * - Backdrop click → dismiss
 * - Escape key → dismiss
 * - Focus trap (keeps focus inside modal)
 * - Cleanup on unmount
 *
 * Usage:
 *   class MyModal extends ModalView {
 *     renderContent() { return h("div", {}, "hello"); }
 *     _onDismiss() { this.close(); }
 *   }
 *   const modal = new MyModal({ bus });
 *   modal.open();  // mounts to document.body
 *   modal.close(); // unmounts + removes from DOM
 */
export class ModalView extends BusComponent {
  constructor({ bus } = {}) {
    super({ bus });
    this._overlayEl = null;
    this._panelEl = null;
    this._onKeyDown = null;
  }

  /** Mount overlay to document.body and render. */
  open() {
    if (this._overlayEl) return;
    this._overlayEl = h("div", {
      className: "fixed inset-0 z-[1000] flex items-center justify-center",
      style: { animation: "rz-modal-fade-in 150ms ease-out" },
    }, []);

    const backdrop = h("div", {
      className: "absolute inset-0 bg-surface-container-lowest/80 backdrop-blur-sm",
    }, []);
    backdrop.addEventListener("click", () => this._onDismiss());
    this._overlayEl.appendChild(backdrop);

    this._panelEl = h("div", {
      className: "relative z-10 bg-surface-container border border-outline-variant/30 rounded-lg shadow-2xl max-w-md w-full mx-space-md overflow-hidden",
      style: { animation: "rz-modal-scale-in 150ms ease-out" },
    }, []);
    this._overlayEl.appendChild(this._panelEl);

    const content = this.renderContent();
    if (content) this._panelEl.appendChild(content);

    document.body.appendChild(this._overlayEl);
    this.mount(this._overlayEl);

    // Escape key
    this._onKeyDown = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        this._onDismiss();
      }
    };
    document.addEventListener("keydown", this._onKeyDown);

    // Focus first focusable element
    const focusable = this._panelEl.querySelector("button, input, [tabindex]");
    if (focusable) focusable.focus();
  }

  /** Remove overlay and unmount. */
  close() {
    if (this._onKeyDown) {
      document.removeEventListener("keydown", this._onKeyDown);
      this._onKeyDown = null;
    }
    if (this._overlayEl && this._overlayEl.parentNode) {
      this._overlayEl.parentNode.removeChild(this._overlayEl);
    }
    this._panelEl = null;
    this._overlayEl = null;
    this.unmount();
  }

  /**
   * Override in subclass. Return a DOM element to render inside the panel.
   * @returns {Element}
   */
  renderContent() {
    return null;
  }

  /**
   * Called when the user dismisses (backdrop click, escape key).
   * Override to customize. Default: close().
   */
  _onDismiss() {
    this.close();
  }

  unmount() {
    if (this._onKeyDown) {
      document.removeEventListener("keydown", this._onKeyDown);
      this._onKeyDown = null;
    }
    this._panelEl = null;
    this._overlayEl = null;
    super.unmount();
  }
}
