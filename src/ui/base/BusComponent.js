import { Component } from "rez-ui/framework";

/**
 * BusComponent: a Component that has access to the application bus.
 *
 * Adds:
 *   - this.bus           — the shared event/function/store bus
 *   - this._listen(name, handler) — subscribe to a bus event with auto-cleanup
 *   - this._subscribe(store, handler) — inherited from Component
 *
 * All UI nodes in rez-chat extend this. There is no Scene / View distinction:
 * everything is a Component, and a BusComponent is a Component with bus
 * access. Top-level scenes, mid-level tabs/panes, leaf rows — all the same.
 */
export class BusComponent extends Component {
  constructor({ bus } = {}) {
    super();
    if (!bus || typeof bus !== "object") {
      throw new Error("BusComponent requires bus");
    }
    this.bus = bus;
    this._busOffs = [];
  }

  _listen(eventName, handler) {
    const off = this.bus.on(eventName, handler);
    if (typeof off === "function") {
      this._busOffs.push(off);
    }
    return off;
  }

  unmount() {
    for (const off of this._busOffs.splice(0)) {
      try {
        off();
      } catch {
        // ignore unsubscribe failures
      }
    }
    super.unmount();
  }
}
