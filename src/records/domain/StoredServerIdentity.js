import { RRecord } from "@rezprotocol/sdk/client";
import { nonEmptyString } from "./coerce.js";

/**
 * StoredServerIdentity: the persisted local identity envelope for the
 * chat-server process. Contains the account id, the per-process device id,
 * and the keypair (Base64). Stored once on first boot and loaded thereafter.
 *
 * S9: `hasAdminRoot` distinguishes an admin-root row (holds the account
 * private key — every pre-S9 blob, where the field is absent) from a
 * DELEGATED row (seedless device: account PUBLIC key only; the device key C
 * signs under a capability chain that is NOT persisted here — the vault is
 * its SSOT and supplies it at every boot).
 */
export class StoredServerIdentity extends RRecord {
  static type = "chat.storedServerIdentity";

  constructor(raw = {}) {
    super();
    this.accountId = nonEmptyString(raw.accountId);
    this.deviceId = nonEmptyString(raw.deviceId);
    this.publicKeyB64 = nonEmptyString(raw.publicKeyB64);
    this.privateKeyB64 = nonEmptyString(raw.privateKeyB64);
    // Absent on every pre-S9 blob ⇒ admin root (private key required).
    this.hasAdminRoot = raw.hasAdminRoot === false ? false : true;
    this._seal();
  }

  validate() {
    this.assert(this.accountId.length > 0, "StoredServerIdentity requires accountId");
    this.assert(this.deviceId.length > 0, "StoredServerIdentity requires deviceId");
    this.assert(this.publicKeyB64.length > 0, "StoredServerIdentity requires publicKeyB64");
    if (this.hasAdminRoot === false) {
      this.assert(this.privateKeyB64.length === 0, "StoredServerIdentity delegated row must not carry privateKeyB64");
    } else {
      this.assert(this.privateKeyB64.length > 0, "StoredServerIdentity requires privateKeyB64");
    }
  }
}
