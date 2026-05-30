import { RRecord } from "@rezprotocol/sdk/client";
import { AuthBootstrapDiagnostic } from "./AuthBootstrapDiagnostic.js";
import { SessionUiDiagnostic } from "./SessionUiDiagnostic.js";

export class LoginDiagnosticResult extends RRecord {
  static type = "chat.loginDiagnosticResult";

  constructor(raw = {}) {
    super();
    const src = raw && typeof raw === "object" ? raw : {};
    this.diagnostic = src.diagnostic instanceof AuthBootstrapDiagnostic
      ? src.diagnostic
      : new AuthBootstrapDiagnostic(src.diagnostic || {});
    this.session = src.session instanceof SessionUiDiagnostic
      ? src.session
      : new SessionUiDiagnostic(src.session || {});
    this._seal();
  }

  validate() {}
}
