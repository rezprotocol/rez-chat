export class BaseBusService {
  constructor({ bus } = {}) {
    if (!bus || typeof bus !== "object") {
      throw new Error("BaseBusService requires bus");
    }
    this.bus = bus;
    this._offs = [];
  }

  _listen(eventName, handler) {
    const off = this.bus.on(eventName, handler);
    if (typeof off === "function") {
      this._offs.push(off);
    }
    return off;
  }

  _register(namespace, name, fn) {
    this.bus.registerFunction({ namespace, name, fn });
  }

  stop() {
    for (const off of this._offs.splice(0)) {
      try {
        off();
      } catch {
        // ignore teardown failures
      }
    }
  }
}
