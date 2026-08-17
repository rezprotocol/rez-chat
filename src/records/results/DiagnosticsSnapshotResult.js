import { SchemaRecord } from "../SchemaRecord.js";

/**
 * The redacted diagnostic bundle a tester can attach to a bug report.
 *
 * Deliberately loose in shape: the interesting fields (`counts`,
 * `capabilities`, `recentErrors`) grow as the app grows, and pinning each one
 * here would mean a schema change every time a new subsystem starts reporting.
 * The guarantee that matters is not the shape — it is that every value passed
 * through src/server/diagnostics/redact.js before it was ever stored. See
 * docs/DIAGNOSTICS.md.
 *
 * `recentErrorsDropped` is required, not optional: a bounded ring buffer that
 * silently truncates reads as "only this much went wrong", which is precisely
 * the wrong conclusion to hand someone triaging a bug.
 */
export class DiagnosticsSnapshotResult extends SchemaRecord {
  static type = "chat.result.diagnostics_snapshot";
  static schema = {
    kind: { type: "string", required: true, trim: true },
    generatedAtMs: { type: "number", required: true },
    note: { type: "string", default: "" },
    app: { type: "object", nullable: true },
    capabilities: { type: "object", nullable: true },
    counts: { type: "object", nullable: true },
    recentErrors: { type: "array", default: [] },
    recentErrorsDropped: { type: "int", default: 0 },
  };
}
