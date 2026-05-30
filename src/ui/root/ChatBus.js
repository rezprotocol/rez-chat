function createDeferred() {
  let resolve = null;
  const promise = new Promise((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

export class ChatBus {
  #eventHandlers;

  constructor({ config = {}, logger = console } = {}) {
    this.#eventHandlers = new Map();
    this.config = config && typeof config === "object" ? config : {};
    this.logger = logger || console;
    this.ready = {};
    this.resolveReady = {};
    this.ui = {};
    this.stores = {};
    this.services = {};
    this.runtime = {};
    this.scenes = {};
    this.views = {};
    this.utils = {};
    this.functions = {};
    this._createReadyGate("app");
    this._createReadyGate("runtime");
  }

  _createReadyGate(name) {
    const key = String(name || "").trim();
    if (!key) return;
    const deferred = createDeferred();
    this.ready[key] = deferred.promise;
    this.resolveReady[key] = deferred.resolve;
  }

  on(eventName, handler) {
    const name = String(eventName || "").trim();
    if (!name || typeof handler !== "function") return () => {};
    let handlers = this.#eventHandlers.get(name);
    if (!handlers) {
      handlers = new Set();
      this.#eventHandlers.set(name, handlers);
    }
    handlers.add(handler);
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) {
        this.#eventHandlers.delete(name);
      }
    };
  }

  off(eventName, handler) {
    const name = String(eventName || "").trim();
    const handlers = this.#eventHandlers.get(name);
    if (!handlers) return;
    handlers.delete(handler);
    if (handlers.size === 0) {
      this.#eventHandlers.delete(name);
    }
  }

  emit(eventName, payload = null) {
    const name = String(eventName || "").trim();
    if (!name) return;
    const handlers = this.#eventHandlers.get(name);
    if (!handlers || handlers.size === 0) return;
    for (const handler of [...handlers]) {
      try {
        handler(payload);
      } catch (err) {
        if (this.logger && typeof this.logger.error === "function") {
          this.logger.error("ChatBus handler failed", name, err && err.message ? err.message : err);
        }
      }
    }
  }

  registerFunction({ namespace, name, fn } = {}) {
    const ns = String(namespace || "").trim();
    const key = String(name || "").trim();
    if (!ns || !key || typeof fn !== "function") {
      throw new Error("ChatBus.registerFunction requires namespace, name, fn");
    }
    let target = this.functions[ns];
    if (!target || typeof target !== "object") {
      target = {};
      this.functions[ns] = target;
    }
    target[key] = fn;
  }

  async call(namespace, name, payload = {}) {
    const ns = String(namespace || "").trim();
    const key = String(name || "").trim();
    const bucket = ns ? this.functions[ns] : null;
    const fn = bucket && typeof bucket === "object" ? bucket[key] : null;
    if (typeof fn !== "function") {
      throw new Error("ChatBus missing function " + ns + "." + key);
    }
    return fn(payload);
  }
}
