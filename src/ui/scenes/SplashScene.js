import { BusComponent } from "../base/BusComponent.js";
import { SplashView } from "../views/SplashView.js";

export class SplashScene extends BusComponent {
  constructor({ bus } = {}) {
    super({ bus });
    this._view = null;
  }

  mount(mountEl) {
    super.mount(mountEl);
    if (!this._rootEl) return;
    this._view = new SplashView({ bus: this.bus });
    this._view.mount(this._rootEl);
  }

  unmount() {
    if (this._view) {
      this._view.unmount();
      this._view = null;
    }
    super.unmount();
  }
}
