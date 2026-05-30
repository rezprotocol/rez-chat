function createDeferred() {
  let resolve = null;
  const promise = new Promise((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

export class ChatServerBus {
  #eventHandlers;

  constructor({ config = {}, logger = console } = {}) {
    this.#eventHandlers = new Map();
    this.config = config && typeof config === "object" ? config : {};
    this.logger = logger || console;
    this.ready = {};
    this.resolveReady = {};
    this.runtime = {};
    this.stores = {};
    this.services = {};
    this.transport = {};
    this.host = {};
    this.records = {};
    this.utils = {};
    this.functions = {};
    this._createReadyGate("server");
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
          this.logger.error("ChatServerBus handler failed", name, err && err.message ? err.message : err);
        }
      }
    }
  }

  registerFunction({ namespace, name, fn } = {}) {
    const ns = String(namespace || "").trim();
    const key = String(name || "").trim();
    if (!ns || !key || typeof fn !== "function") {
      throw new Error("ChatServerBus.registerFunction requires namespace, name, fn");
    }
    let bucket = this.functions[ns];
    if (!bucket || typeof bucket !== "object") {
      bucket = {};
      this.functions[ns] = bucket;
    }
    bucket[key] = fn;
  }

  async call(namespace, name, payload = {}) {
    const ns = String(namespace || "").trim();
    const key = String(name || "").trim();
    const bucket = ns ? this.functions[ns] : null;
    const fn = bucket && typeof bucket === "object" ? bucket[key] : null;
    if (typeof fn !== "function") {
      throw new Error("ChatServerBus missing function " + ns + "." + key);
    }
    return fn(payload);
  }
}
