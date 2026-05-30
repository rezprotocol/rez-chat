import { RRecord } from "@rezprotocol/sdk/client";

/**
 * SchemaRecord: declarative RRecord. Subclasses set `static schema = {...}`
 * mapping field name → spec; the base constructor coerces every field in
 * declaration order, then `_seal()` runs `validate()` (which the base
 * implements from the same schema) and freezes the instance.
 *
 * Subclasses needing extra checks override `validate()` and call
 * `super.validate()` first. Subclasses needing custom field coercion that
 * cannot be expressed in the schema should extend `RRecord` directly with
 * a bespoke constructor — SchemaRecord is intentionally narrow.
 *
 * Schema spec shape per field:
 *   { type: "string" | "int" | "number" | "boolean" | "object" | "array" | "record" | "enum",
 *     required?: boolean,
 *     nullable?: boolean,
 *     default?: any,           // applied when raw value is missing/invalid for the type
 *     trim?: boolean,          // "string" only; default true
 *     maxLength?: number,      // "string" only
 *     min?: number,            // "int" / "number" only
 *     max?: number,            // "int" / "number" only
 *     maxJsonBytes?: number,   // "object" only
 *     record?: Class,          // "array" of records, or "record"
 *     values?: string[],       // "enum"
 *   }
 *
 * Semantics:
 *   - `required` on string  → length > 0
 *   - `required` on int     → value > 0   (zero is treated as missing)
 *   - `required` on number  → value > 0
 *   - `required` on object  → not null
 *   - `required` on record  → not null
 *   - `required` on array   → length > 0
 *   - `required` on enum    → present in `values`
 *   - `nullable` on string  → if raw absent/empty, store null instead of ""
 *   - `nullable` on int     → if raw not finite, store null instead of 0
 *   - `nullable` on object  → if raw not object, store null instead of {}
 *   - `nullable` on record  → if raw absent, store null instead of constructing
 */
export class SchemaRecord extends RRecord {
  constructor(raw = {}) {
    super();
    const input = raw && typeof raw === "object" ? raw : {};
    this._beforeSchemaCoerce(input);
    const schema = this.constructor.schema;
    if (!schema || typeof schema !== "object") {
      throw new Error(`${this.constructor.name}: static schema required for SchemaRecord subclass`);
    }
    for (const [name, spec] of Object.entries(schema)) {
      this[name] = coerceField(name, input[name], spec);
    }
    this._seal();
  }

  /** Override to inject fields BEFORE schema coercion (e.g. wire-payload `kind`). */
  _beforeSchemaCoerce(_input) {}

  validate() {
    const schema = this.constructor.schema || {};
    for (const [name, spec] of Object.entries(schema)) {
      validateField(this, name, this[name], spec);
    }
  }
}

function coerceField(name, raw, spec) {
  switch (spec.type) {
    case "string":
      return coerceString(raw, spec);
    case "int":
      return coerceInt(raw, spec);
    case "number":
      return coerceNumber(raw, spec);
    case "boolean":
      return typeof raw === "boolean" ? raw : (spec.default === true);
    case "object":
      return coerceObject(raw, spec);
    case "array":
      return coerceArray(raw, spec);
    case "record":
      return coerceRecord(raw, spec);
    case "enum":
      return coerceEnum(raw, spec);
    default:
      throw new Error(`SchemaRecord field '${name}': unknown type '${spec.type}'`);
  }
}

function coerceString(raw, spec) {
  if (typeof raw !== "string") {
    if (spec.nullable) return null;
    return typeof spec.default === "string" ? spec.default : "";
  }
  // trim:false preserves the literal input (including empty strings).
  if (spec.trim === false) return spec.lowercase ? raw.toLowerCase() : raw;
  let value = raw.trim();
  if (spec.lowercase) value = value.toLowerCase();
  if (!value) {
    if (spec.nullable) return null;
    return typeof spec.default === "string" ? spec.default : "";
  }
  return value;
}

function coerceInt(raw, spec) {
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    if (spec.nullable) return null;
    return typeof spec.default === "number" ? Math.trunc(spec.default) : 0;
  }
  let value = Math.trunc(n);
  if (spec.clamp) {
    if (spec.min != null && value < spec.min) value = spec.min;
    if (spec.max != null && value > spec.max) value = spec.max;
  }
  return value;
}

function coerceNumber(raw, spec) {
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    if (spec.nullable) return null;
    return typeof spec.default === "number" ? spec.default : 0;
  }
  let value = n;
  if (spec.clamp) {
    if (spec.min != null && value < spec.min) value = spec.min;
    if (spec.max != null && value > spec.max) value = spec.max;
  }
  return value;
}

function coerceObject(raw, spec) {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw;
  if (spec.nullable) return null;
  return spec.default !== undefined ? spec.default : null;
}

function coerceArray(raw, spec) {
  if (!Array.isArray(raw)) return [];
  if (spec.record) {
    const RecordClass = spec.record;
    return raw.map((item) => (item instanceof RecordClass ? item : new RecordClass(item || {})));
  }
  return raw.slice();
}

function coerceRecord(raw, spec) {
  const RecordClass = spec.record;
  if (!RecordClass) throw new Error("SchemaRecord 'record' field requires record: Class");
  if (raw instanceof RecordClass) return raw;
  if (raw == null) return spec.nullable ? null : new RecordClass({});
  return new RecordClass(raw);
}

function coerceEnum(raw, spec) {
  const values = Array.isArray(spec.values) ? spec.values : [];
  if (typeof raw === "string" && values.includes(raw)) return raw;
  if (typeof spec.default === "string" && values.includes(spec.default)) return spec.default;
  return spec.nullable ? null : (values[0] || "");
}

function validateField(record, name, value, spec) {
  if (spec.required) {
    switch (spec.type) {
      case "string":
        record.assert(typeof value === "string" && value.length > 0, `${name} required`);
        break;
      case "int":
      case "number":
        record.assert(typeof value === "number" && value > 0, `${name} > 0 required`);
        break;
      case "object":
        record.assert(value !== null && typeof value === "object", `${name} required`);
        break;
      case "record":
        record.assert(value !== null, `${name} required`);
        break;
      case "array":
        record.assert(Array.isArray(value) && value.length > 0, `${name} required (non-empty array)`);
        break;
      case "enum": {
        const values = Array.isArray(spec.values) ? spec.values : [];
        record.assert(typeof value === "string" && values.includes(value), `${name} must be one of ${values.join("|")}, got '${value}'`);
        break;
      }
      default:
        break;
    }
  }
  if (spec.maxLength != null && spec.type === "string" && typeof value === "string") {
    record.assert(value.length <= spec.maxLength, `${name} exceeds ${spec.maxLength} chars`);
  }
  if (spec.maxJsonBytes != null && spec.type === "object" && value !== null) {
    const json = JSON.stringify(value);
    record.assert(json.length <= spec.maxJsonBytes, `${name} exceeds ${spec.maxJsonBytes}B limit`);
  }
  if (!spec.clamp && spec.min != null && (spec.type === "int" || spec.type === "number") && typeof value === "number") {
    record.assert(value >= spec.min, `${name} must be >= ${spec.min}, got ${value}`);
  }
  if (!spec.clamp && spec.max != null && (spec.type === "int" || spec.type === "number") && typeof value === "number") {
    record.assert(value <= spec.max, `${name} must be <= ${spec.max}, got ${value}`);
  }
  if (spec.type === "enum" && !spec.required) {
    const values = Array.isArray(spec.values) ? spec.values : [];
    if (typeof value === "string" && value.length > 0) {
      record.assert(values.includes(value), `${name} must be one of ${values.join("|")}, got '${value}'`);
    }
  }
  if (typeof spec.validate === "function") {
    spec.validate(value, record, name);
  }
}
