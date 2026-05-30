import { RRecord } from "@rezprotocol/sdk/client";

export class SessionUiDiagnostic extends RRecord {
  static type = "chat.sessionUiDiagnostic";

  constructor(raw = {}) {
    super();
    const src = raw && typeof raw === "object" ? raw : {};
    this.status = typeof src.status === "string" ? src.status : "";
    this.error = typeof src.error === "string" ? src.error : "";
    this.selectedAccountId = typeof src.selectedAccountId === "string" ? src.selectedAccountId : "";
    this.accountListCount = Number.isFinite(Number(src.accountListCount)) ? Number(src.accountListCount) : 0;
    this.authScreen = typeof src.authScreen === "string" ? src.authScreen : "unlock";
    this.showCreateBranch = src.showCreateBranch === true;
    this._seal();
  }

  validate() {
    this.assert(typeof this.status === "string", "status must be string");
    this.assert(typeof this.error === "string", "error must be string");
    this.assert(typeof this.selectedAccountId === "string", "selectedAccountId must be string");
    this.assert(Number.isFinite(this.accountListCount), "accountListCount must be finite");
    this.assert(typeof this.authScreen === "string", "authScreen must be string");
    this.assert(typeof this.showCreateBranch === "boolean", "showCreateBranch must be boolean");
  }
}
