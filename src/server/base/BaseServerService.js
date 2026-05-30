export class BaseServerService {
  #offs;
  #ownerAccountId;

  constructor({ bus, ownerAccountId = null, logger = console } = {}) {
    if (!bus || typeof bus !== "object") {
      throw new Error(`${this.constructor.name} requires bus`);
    }
    this.bus = bus;
    this.logger = logger || console;
    this.#offs = [];
    this.#ownerAccountId = null;
    if (ownerAccountId !== null) {
      if (typeof ownerAccountId !== "string" || ownerAccountId.trim().length === 0) {
        throw new Error(`${this.constructor.name} requires ownerAccountId`);
      }
      this.#ownerAccountId = ownerAccountId.trim();
    }
  }

  get ownerAccountId() {
    return this.#ownerAccountId;
  }

  /**
   * Bridge handlers receive `payload` that may be a record instance OR a raw
   * object from a remote transport. This coerces to the declared param record
   * exactly once. Returns the record instance; subclasses read `.field` from it.
   */
  _coerceParams(payload, ParamClass) {
    if (typeof ParamClass !== "function") {
      throw new Error(`${this.constructor.name}._coerceParams: ParamClass required`);
    }
    return payload instanceof ParamClass ? payload : new ParamClass(payload || {});
  }

  _listen(eventName, handler) {
    const off = this.bus.on(eventName, handler);
    if (typeof off === "function") {
      this.#offs.push(off);
    }
    return off;
  }

  _register(namespace, name, fn) {
    this.bus.registerFunction({ namespace, name, fn });
  }

  _call(namespace, name, payload) {
    return this.bus.call(namespace, name, payload);
  }

  _emit(eventName, payload) {
    this.bus.emit(eventName, payload);
  }

  async start() {}

  async stop() {
    for (const off of this.#offs.splice(0)) {
      try {
        off();
      } catch {
        // ignore teardown failures
      }
    }
  }
}
