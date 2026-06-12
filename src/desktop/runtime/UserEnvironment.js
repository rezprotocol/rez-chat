/**
 * Probes the host machine for capabilities the app should adapt to, once at
 * sidecar boot, and caches the result. This is the single source of truth for
 * "what can this machine do" — both the vault's device-unlock adapter and the
 * UI read from it, so we never probe the same capability twice or let two
 * layers disagree.
 *
 * Capabilities probed today:
 *   - os / arch            process.platform / process.arch (no host needed)
 *   - keychainAvailable    host `keychain.probe` — is an OS keychain / secret
 *                          service usable WITHOUT creating a key or prompting.
 *                          False on e.g. a Linux box with no Secret Service.
 *   - biometricAvailable   host `biometric.isAvailable` — Touch ID / Windows
 *                          Hello present (no prompt; just canEvaluatePolicy).
 *   - notificationsAllowed reserved (null) until the notification-permission
 *                          host op is wired.
 *
 * Probing degrades gracefully: a missing/slow host (tests, headless runs)
 * yields `false` for host-backed capabilities rather than hanging or throwing,
 * mirroring how the rest of the sidecar treats an absent host.
 */
export class UserEnvironment {
  #hostChannel;
  #logger;
  #caps;

  constructor({ hostChannel = null, logger = console } = {}) {
    this.#hostChannel = hostChannel && typeof hostChannel.request === "function" ? hostChannel : null;
    this.#logger = logger || console;
    this.#caps = null;
  }

  /**
   * Probe the host once and cache the result. Subsequent calls return the
   * cached snapshot. Host-backed probes run concurrently and each fails closed
   * (to `false`) so one unavailable capability never blocks the others.
   */
  async probe() {
    if (this.#caps) return this.#caps;
    const [keychainAvailable, biometricAvailable] = await Promise.all([
      this.#probeHostBoolean("keychain.probe"),
      this.#probeHostBoolean("biometric.isAvailable"),
    ]);
    this.#caps = Object.freeze({
      os: process.platform,
      arch: process.arch,
      keychainAvailable,
      biometricAvailable,
      notificationsAllowed: null,
    });
    return this.#caps;
  }

  /**
   * The cached capabilities snapshot. Returns a fail-closed default (all host
   * capabilities false) if probe() has not completed — callers should probe()
   * at boot before relying on this.
   */
  capabilities() {
    if (this.#caps) return { ...this.#caps };
    return {
      os: process.platform,
      arch: process.arch,
      keychainAvailable: false,
      biometricAvailable: false,
      notificationsAllowed: null,
    };
  }

  async #probeHostBoolean(op) {
    if (!this.#hostChannel) return false;
    try {
      const result = await this.#hostChannel.request(op, {});
      return !!(result && result.available === true);
    } catch (err) {
      if (this.#logger && typeof this.#logger.warn === "function") {
        this.#logger.warn(
          "[user-environment] capability probe '" + op + "' failed — treating as unavailable:",
          err && err.message ? err.message : err,
        );
      }
      return false;
    }
  }
}
