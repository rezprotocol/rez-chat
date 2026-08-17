import { SchemaRecord } from "../SchemaRecord.js";

/**
 * No parameters: a diagnostic snapshot describes the app's own state, so there
 * is nothing for a caller to choose. Declared as its own empty record rather
 * than borrowing another directive's params, so that adding a real option later
 * (a time window, a section filter) does not silently change the meaning of an
 * unrelated call.
 */
export class DiagnosticsSnapshotParams extends SchemaRecord {
  static type = "chat.params.diagnostics_snapshot";
  static schema = {};
}
