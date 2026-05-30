/**
 * StoreBase: shared subscribe/emit lifecycle for per-domain stores.
 *
 * Stores own truth. They emit structured events and never do IO.
 * Event shape: { store, type, keys, meta: { ts, source } }
 *
 * Architectural invariant (renderer):
 *   - Stores own their state and read NO peers. A store that needs to
 *     reach into another store is a layer violation.
 *   - Cross-store derivation lives in `src/ui/queries/`: pure functions
 *     with signature `(stores, ...args) => answer` that compose
 *     own-store accessors across multiple stores.
 *   - Views call exactly one of {own-store accessor, query, direct record
 *     field read} per render decision.
 *
 * The optional `bus` parameter is accepted for compatibility with the
 * existing construction signature; stores do not use it for cross-store
 * reads. (It remains useful for emitting bus-level error events.)
 */
export class StoreBase {
  #handlers;
  #storeName;
  #defaultSource;
  #bus;

  constructor({ storeName, defaultSource = "", bus = null } = {}) {
    const name = String(storeName || "").trim();
    if (!name) throw new Error("StoreBase requires storeName");
    this.#storeName = name;
    this.#defaultSource = String(defaultSource || name).trim();
    this.#handlers = new Set();
    this.#bus = bus || null;
  }

  get storeName() {
    return this.#storeName;
  }

  subscribe(handler) {
    if (typeof handler !== "function") return () => {};
    this.#handlers.add(handler);
    return () => this.#handlers.delete(handler);
  }

  onChange(handler) {
    return this.subscribe(handler);
  }

  _emit(type, keys = {}, meta = {}) {
    const eventType = String(type || "").trim();
    if (!eventType) return;
    const baseMeta = { ts: Date.now(), source: this.#defaultSource };
    const mergedMeta = meta && typeof meta === "object" ? { ...baseMeta, ...meta } : baseMeta;
    const event = {
      store: this.#storeName,
      type: eventType,
      keys: keys && typeof keys === "object" ? keys : {},
      meta: mergedMeta,
    };
    for (const handler of [...this.#handlers]) {
      try {
        handler(event);
      } catch (err) {
        // Subscriber failures must not break other subscribers. Surface
        // through the bus error channel if available; otherwise log so
        // the failure isn't silent.
        const bus = this.#bus;
        if (bus && typeof bus.emit === "function") {
          bus.emit("app.error", {
            source: this.#defaultSource,
            message: "store subscriber threw",
            severity: "error",
            err,
          });
        } else {
          console.error("[" + this.#defaultSource + "] subscriber threw", err);
        }
      }
    }
  }
}
