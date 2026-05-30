import { RRecord } from "@rezprotocol/sdk/client";
import { AuthBootstrapDiagnostic } from "./AuthBootstrapDiagnostic.js";

export class AuthBootstrapDiagnosticResult extends RRecord {
  static type = "chat.authBootstrapDiagnosticResult";

  constructor(raw = {}) {
    super();
    const src = raw && raw.diagnostic ? raw.diagnostic : raw;
    this.diagnostic = src instanceof AuthBootstrapDiagnostic ? src : new AuthBootstrapDiagnostic(src || {});
    this._seal();
  }

  validate() {}
}
