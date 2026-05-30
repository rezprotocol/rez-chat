import { RRecord } from "@rezprotocol/sdk/client";
import { nonEmptyString } from "./coerce.js";

/**
 * StoredServerIdentity: the persisted local identity envelope for the
 * chat-server process. Contains the account id, the per-process device id,
 * and the keypair (Base64). Stored once on first boot and loaded thereafter.
 */
export class StoredServerIdentity extends RRecord {
  static type = "chat.storedServerIdentity";

  constructor(raw = {}) {
    super();
    this.accountId = nonEmptyString(raw.accountId);
    this.deviceId = nonEmptyString(raw.deviceId);
    this.publicKeyB64 = nonEmptyString(raw.publicKeyB64);
    this.privateKeyB64 = nonEmptyString(raw.privateKeyB64);
    this._seal();
  }

  validate() {
    this.assert(this.accountId.length > 0, "StoredServerIdentity requires accountId");
    this.assert(this.deviceId.length > 0, "StoredServerIdentity requires deviceId");
    this.assert(this.publicKeyB64.length > 0, "StoredServerIdentity requires publicKeyB64");
    this.assert(this.privateKeyB64.length > 0, "StoredServerIdentity requires privateKeyB64");
  }
}
