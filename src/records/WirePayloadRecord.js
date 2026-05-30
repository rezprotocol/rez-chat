import { SchemaRecord } from "./SchemaRecord.js";

/**
 * WirePayloadRecord: a SchemaRecord whose subclasses are versioned wire
 * payloads carried inside encrypted deposits. Each subclass declares:
 *
 *   static KIND = "rez.X.v1"
 *   static schema = { ...fields }
 *
 * The base auto-derives `static type` from `KIND` (so registry lookups
 * and RRecord identity agree without restating the constant), and
 * injects `this.kind = KIND` ahead of schema coercion so the discriminator
 * is the first field in `toJSON()` — matching the wire format the
 * receiver's PAYLOAD_KIND_REGISTRY dispatches on.
 */
export class WirePayloadRecord extends SchemaRecord {
  static get type() {
    return this.KIND;
  }

  _beforeSchemaCoerce(_input) {
    const KIND = this.constructor.KIND;
    if (typeof KIND !== "string" || !KIND) {
      throw new Error(`${this.constructor.name}: static KIND required for WirePayloadRecord subclass`);
    }
    this.kind = KIND;
  }
}
