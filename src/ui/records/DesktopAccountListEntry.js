import { RRecord } from "@rezprotocol/sdk/client";
import { nonEmptyString } from "../../records/domain/coerce.js";

/**
 * DesktopAccountListEntry: one entry in the desktop vault's account-picker
 * list. Sourced from the Electron desktop bridge's `vault.listAccounts()`
 * response; surfaced to the AuthStore for the unlock screen.
 */
export class DesktopAccountListEntry extends RRecord {
  static type = "chat.desktopAccountListEntry";

  constructor(raw = {}) {
    super();
    // Bridge responses use `id` OR `accountIdHint` for the identifier;
    // tolerate either at the trust boundary.
    const idCandidate = nonEmptyString(raw.id) || nonEmptyString(raw.accountIdHint);
    this.id = idCandidate;
    this.label = nonEmptyString(raw.label) || "Account";
    this.accountIdHint = nonEmptyString(raw.accountIdHint);
    this.deviceUnlockEnabled = raw.deviceUnlockEnabled === true;
    this._seal();
  }

  validate() {
    this.assert(this.id.length > 0, "DesktopAccountListEntry requires id");
  }
}
