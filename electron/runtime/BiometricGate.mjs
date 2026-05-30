/**
 * Cross-platform biometric authorization gate.
 *
 * `requireBiometric({reason})` prompts the user to authorize via Touch ID
 * (macOS), Windows Hello (Windows), or no-op (Linux — libsecret already gates
 * `safeStorage` at the OS layer). Resolves on success, throws on cancel /
 * unavailability.
 *
 * This is the user-authorization gesture only. The cryptographic boundary
 * remains `safeStorage`; the biometric prompt does not derive any key.
 *
 * Callers pass `systemPreferences` (Electron) and optionally an override for
 * `process.platform` (for tests).
 */

export class BiometricUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = "BiometricUnavailableError";
    this.code = "BIOMETRIC_UNAVAILABLE";
  }
}

export class BiometricCancelledError extends Error {
  constructor(message) {
    super(message);
    this.name = "BiometricCancelledError";
    this.code = "BIOMETRIC_CANCELLED";
  }
}

function normalizeReason(reason) {
  const value = String(reason == null ? "" : reason).trim();
  return value || "authenticate";
}

export class BiometricGate {
  #systemPreferences;
  #platform;
  #windowsHelloAdapter;

  constructor({ systemPreferences = null, platform = process.platform, windowsHelloAdapter = null } = {}) {
    this.#systemPreferences = systemPreferences;
    this.#platform = String(platform || "").toLowerCase();
    this.#windowsHelloAdapter = windowsHelloAdapter;
  }

  isAvailable() {
    if (this.#platform === "darwin") {
      const sp = this.#systemPreferences;
      if (!sp || typeof sp.canPromptTouchID !== "function") return false;
      return sp.canPromptTouchID() === true;
    }
    if (this.#platform === "win32") {
      const adapter = this.#windowsHelloAdapter;
      if (!adapter || typeof adapter.isAvailable !== "function") return false;
      return adapter.isAvailable() === true;
    }
    // Linux / others: no biometric gesture, but device unlock still works
    // via safeStorage (libsecret). Report unavailable so callers don't
    // auto-prompt; the unlock path itself does not require a gesture.
    return false;
  }

  async requireBiometric({ reason = "" } = {}) {
    const prompt = normalizeReason(reason);
    if (this.#platform === "darwin") {
      return this.#requireMac(prompt);
    }
    if (this.#platform === "win32") {
      return this.#requireWindows(prompt);
    }
    // SECURITY_AUDIT MED-18: fail-closed on Linux. Linux has no portable
    // user-gesture biometric API — the previous pass-through "return true"
    // semantic meant any future caller that used BiometricGate alone
    // (without an upstream safeStorage check) got a free unlock on Linux.
    // Callers that intend to gate via safeStorage MUST call isAvailable()
    // first and skip the biometric step explicitly; they must NOT rely on
    // a silent success.
    //
    // Per-OS threat model:
    //   - macOS:   Touch ID / Apple Watch via LocalAuthentication (sp.promptTouchID).
    //   - Windows: Windows Hello via KeyCredentialManager (adapter.requestVerification).
    //   - Linux:   no portable biometric API. requireBiometric throws;
    //              callers fall back to safeStorage gating (libsecret/kwallet
    //              user-session unlock) or password-only unlock.
    throw new BiometricUnavailableError(
      "BiometricGate: no biometric API available on this platform (" + this.#platform + ")",
    );
  }

  async #requireMac(prompt) {
    const sp = this.#systemPreferences;
    if (!sp || typeof sp.promptTouchID !== "function") {
      throw new BiometricUnavailableError("Touch ID unavailable on this system");
    }
    if (typeof sp.canPromptTouchID === "function" && sp.canPromptTouchID() !== true) {
      throw new BiometricUnavailableError("Touch ID not enrolled");
    }
    try {
      await sp.promptTouchID(prompt);
      return true;
    } catch (err) {
      throw new BiometricCancelledError(err && err.message ? err.message : "Touch ID cancelled");
    }
  }

  async #requireWindows(prompt) {
    const adapter = this.#windowsHelloAdapter;
    if (!adapter || typeof adapter.requestVerification !== "function") {
      throw new BiometricUnavailableError("Windows Hello adapter not configured");
    }
    if (typeof adapter.isAvailable === "function" && adapter.isAvailable() !== true) {
      throw new BiometricUnavailableError("Windows Hello not available");
    }
    const result = await adapter.requestVerification(prompt);
    if (result === true) return true;
    throw new BiometricCancelledError("Windows Hello verification failed or was cancelled");
  }
}
