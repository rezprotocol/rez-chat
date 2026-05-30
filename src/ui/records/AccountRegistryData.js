import { RRecord } from "@rezprotocol/sdk/client";

export class AccountRegistryData extends RRecord {
  static type = "chat.accountRegistryData";

  constructor(raw = {}) {
    super();
    const src = raw && typeof raw === "object" ? raw : {};
    const ids = Array.isArray(src.accountIds)
      ? src.accountIds.filter((id) => typeof id === "string" && id.trim().length > 0)
      : [];
    const h = src.hints != null && typeof src.hints === "object" ? src.hints : {};
    this.accountIds = ids;
    this.hints = h;
    this._seal();
  }

  validate() {
    this.assert(Array.isArray(this.accountIds), "accountIds must be array");
    this.assert(this.hints != null && typeof this.hints === "object", "hints must be object");
  }
}
