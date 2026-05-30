import { RRecord } from "@rezprotocol/sdk/client";

/**
 * DesktopVaultStatus: snapshot of the local Electron vault state used
 * during auth bootstrap. `hasAccounts === true` means the picker should
 * show locked-vault UI; otherwise the create-account flow runs.
 */
export class DesktopVaultStatus extends RRecord {
  static type = "chat.desktopVaultStatus";

  constructor(raw = {}) {
    super();
    // Bridge responses are sometimes `{ vault: {...} }` and sometimes the
    // inner status object directly. Unwrap here.
    const status = raw && raw.vault && typeof raw.vault === "object"
      ? raw.vault
      : (raw && typeof raw === "object" ? raw : {});
    this.hasAccounts = status.hasAccounts === true;
    this._seal();
  }

  validate() {}
}
