import { BusComponent } from "../base/BusComponent.js";
import { AppShellView } from "../views/AppShellView.js";
import { ConnectRequestAlertView } from "../views/ConnectRequestAlertView.js";

export class MainScene extends BusComponent {
  constructor({ bus } = {}) {
    super({ bus });
    this._view = null;
    this._connectAlerts = null;
  }

  mount(mountEl) {
    super.mount(mountEl);
    if (!this._rootEl) return;
    this._view = new AppShellView({ bus: this.bus });
    this._view.mount(this._rootEl);
    const alertSlot = document.createElement("div");
    this._rootEl.appendChild(alertSlot);
    this._connectAlerts = new ConnectRequestAlertView({ bus: this.bus });
    this._connectAlerts.mount(alertSlot);
    this._onFocus = () => {
      this.bus.stores.uiState.setVisibility({ focused: true });
      this.bus.emit("ui.visibility.changed", { focused: true });
    };
    this._onBlur = () => {
      this.bus.stores.uiState.setVisibility({ focused: false });
      this.bus.emit("ui.visibility.changed", { focused: false });
    };
    this._onVisibility = () => {
      const visible = document.visibilityState === "visible";
      this.bus.stores.uiState.setVisibility({ visible });
      this.bus.emit("ui.visibility.changed", { visible });
    };
    window.addEventListener("focus", this._onFocus);
    window.addEventListener("blur", this._onBlur);
    document.addEventListener("visibilitychange", this._onVisibility);
  }

  unmount() {
    if (this._onFocus) {
      window.removeEventListener("focus", this._onFocus);
      this._onFocus = null;
    }
    if (this._onBlur) {
      window.removeEventListener("blur", this._onBlur);
      this._onBlur = null;
    }
    if (this._onVisibility) {
      document.removeEventListener("visibilitychange", this._onVisibility);
      this._onVisibility = null;
    }
    if (this._connectAlerts) {
      this._connectAlerts.unmount();
      this._connectAlerts = null;
    }
    if (this._view) {
      this._view.unmount();
      this._view = null;
    }
    super.unmount();
  }
}
