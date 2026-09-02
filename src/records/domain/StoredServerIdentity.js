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
 *
 * GHSA-7gc9-4c96-2rxm: `rootKeyCustody` says WHERE an admin-root row's private
 * key lives, and it exists so that "this row never held the key" is never
 * confused with "this row lost its key":
 *
 *   "inline" (absent ⇒ this, so every pre-existing blob)
 *       the private key is in this row, in cleartext, on disk. The state the
 *       advisory is about. Still required to carry a key — a priv-less inline
 *       row is corrupt and must throw, not be tolerated.
 *   "vault"
 *       the private key is NOT here. The desktop vault envelope is its only
 *       home and supplies it at every boot. `privateKeyB64` MUST be empty;
 *       a vault row carrying a key means a scrub did not finish.
 *
 * A `"vault"` row is only meaningful for an admin-root identity — a delegated
 * row has no account private key to custody anywhere.
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
    // Absent on every pre-advisory blob ⇒ the key is inline, on disk.
    this.rootKeyCustody = raw.rootKeyCustody === "vault" ? "vault" : "inline";
    this._seal();
  }

  validate() {
    this.assert(this.accountId.length > 0, "StoredServerIdentity requires accountId");
    this.assert(this.deviceId.length > 0, "StoredServerIdentity requires deviceId");
    this.assert(this.publicKeyB64.length > 0, "StoredServerIdentity requires publicKeyB64");
    if (this.hasAdminRoot === false) {
      this.assert(this.rootKeyCustody === "inline",
        "StoredServerIdentity delegated row must not declare rootKeyCustody");
      this.assert(this.privateKeyB64.length === 0, "StoredServerIdentity delegated row must not carry privateKeyB64");
    } else if (this.rootKeyCustody === "vault") {
      // Fails loud in BOTH directions: a vault row holding a key means the
      // scrub did not complete, and that is the exact state this record type
      // exists to make impossible to ship silently.
      this.assert(this.privateKeyB64.length === 0,
        "StoredServerIdentity rootKeyCustody='vault' row must not carry privateKeyB64");
    } else {
      this.assert(this.privateKeyB64.length > 0, "StoredServerIdentity requires privateKeyB64");
    }
  }
}
