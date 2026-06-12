import { RRecord } from "@rezprotocol/sdk/client";

/**
 * UserEnvironmentCapabilities: the UI-side view of what the host machine can
 * do, probed once by the sidecar's UserEnvironment at boot. Lets views adapt
 * their surface — today, hiding the "remember on this device" option when no
 * keychain is available; later, gating biometric / notification affordances.
 *
 * `notificationsAllowed` is intentionally tri-state: true / false once probed,
 * null while the capability is not yet wired (reserved).
 */
export class UserEnvironmentCapabilities extends RRecord {
  static type = "chat.userEnvironmentCapabilities";

  constructor(raw = {}) {
    super();
    const caps = raw && typeof raw === "object" ? raw : {};
    this.os = typeof caps.os === "string" ? caps.os : "";
    this.arch = typeof caps.arch === "string" ? caps.arch : "";
    this.keychainAvailable = caps.keychainAvailable === true;
    this.biometricAvailable = caps.biometricAvailable === true;
    this.notificationsAllowed = caps.notificationsAllowed === true
      ? true
      : (caps.notificationsAllowed === false ? false : null);
    this._seal();
  }

  validate() {}
}
