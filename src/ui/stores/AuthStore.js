export const AUTH_STATUS = Object.freeze({
  NO_KEYSTORE: "NO_KEYSTORE",
  LOCKED: "LOCKED",
  UNLOCKING: "UNLOCKING",
  UNLOCKED: "UNLOCKED",
  LOCKING: "LOCKING",
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export class AuthStore {
  constructor({ bus } = {}) {
    this._bus = bus || null;
    this._state = {
      status: AUTH_STATUS.NO_KEYSTORE,
      error: null,
      accountId: null,
      deviceId: null,
      keystoreMeta: null,
      sessionHandles: null,
      accountList: [],
      selectedAccountId: null,
    };
    this._handlers = new Set();
  }

  onChange(handler) {
    if (typeof handler !== "function") return () => {};
    this._handlers.add(handler);
    return () => this._handlers.delete(handler);
  }

  _emit() {
    for (const h of this._handlers) try { h({ store: "auth" }); } catch (err) {
      console.error("[AuthStore] handler threw", err);
      if (this._bus) this._bus.emit("app.error", { source: "AuthStore", message: "handler threw", severity: "error", err });
    }
  }

  setNoKeystore() {
    this._state.status = AUTH_STATUS.NO_KEYSTORE;
    this._state.error = null;
    this._state.accountId = null;
    this._state.deviceId = null;
    this._state.keystoreMeta = null;
    this._state.sessionHandles = null;
    this._state.accountList = [];
    this._state.selectedAccountId = null;
    this._emit();
  }

  setAccountList(accountList) {
    this._state.accountList = Array.isArray(accountList) ? accountList : [];
    this._emit();
  }

  setSelectedAccountId(selectedAccountId) {
    this._state.selectedAccountId =
      selectedAccountId != null && String(selectedAccountId).trim() !== ""
        ? String(selectedAccountId).trim()
        : null;
    this._emit();
  }

  setLocked({ error = null, keystoreMeta = null } = {}) {
    this._state.status = AUTH_STATUS.LOCKED;
    this._state.error = error ? String(error) : null;
    this._state.accountId = null;
    this._state.deviceId = null;
    this._state.keystoreMeta = keystoreMeta && typeof keystoreMeta === "object"
      ? {
        version: Number(keystoreMeta.version || 0),
        updatedAtMs: Number(keystoreMeta.updatedAtMs || 0) || null,
      }
      : null;
    this._state.sessionHandles = null;
    this._emit();
  }

  beginUnlock() {
    this._state.status = AUTH_STATUS.UNLOCKING;
    this._state.error = null;
    this._state.accountId = null;
    this._state.deviceId = null;
    this._state.sessionHandles = null;
    this._emit();
  }

  completeUnlock({ accountId, deviceId, sessionHandles = null, keystoreMeta = null } = {}) {
    this._state.status = AUTH_STATUS.UNLOCKED;
    this._state.error = null;
    this._state.accountId = String(accountId || "").trim() || null;
    this._state.deviceId = String(deviceId || "").trim() || null;
    this._state.keystoreMeta = keystoreMeta && typeof keystoreMeta === "object"
      ? {
        version: Number(keystoreMeta.version || 0),
        updatedAtMs: Number(keystoreMeta.updatedAtMs || 0) || null,
      }
      : this._state.keystoreMeta;
    this._state.sessionHandles = sessionHandles && typeof sessionHandles === "object"
      ? clone(sessionHandles)
      : null;
    this._emit();
  }

  updateSessionHandles(sessionHandles) {
    this._state.sessionHandles = sessionHandles && typeof sessionHandles === "object"
      ? clone(sessionHandles)
      : null;
    this._emit();
  }

  failUnlock(errorMessage) {
    const message = String(errorMessage || "Unlock failed").trim() || "Unlock failed";
    const meta = this._state.keystoreMeta;
    this.setLocked({ error: message, keystoreMeta: meta });
  }

  beginLocking() {
    this._state.status = AUTH_STATUS.LOCKING;
    this._state.error = null;
    this._emit();
  }

  completeLocking() {
    this._state.status = AUTH_STATUS.LOCKED;
    this._state.error = null;
    this._state.accountId = null;
    this._state.deviceId = null;
    this._state.sessionHandles = null;
    this._state.selectedAccountId = null;
    this._emit();
  }

  snapshot() {
    return clone(this._state);
  }

  // ---- Typed status accessors -------------------------------------------

  isLocked() {
    return this._state.status === AUTH_STATUS.LOCKED;
  }

  isUnlocking() {
    return this._state.status === AUTH_STATUS.UNLOCKING;
  }

  isUnlocked() {
    return this._state.status === AUTH_STATUS.UNLOCKED;
  }

  hasKeystore() {
    return this._state.status !== AUTH_STATUS.NO_KEYSTORE;
  }
}
