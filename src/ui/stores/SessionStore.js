/**
 * Session state machine: NO_KEYSTORE | LOCKED | UNLOCKING | INITIALIZING | UNLOCKED | LOCKING.
 * Owns accountId, deviceId, unlock status, errors (non-secret).
 */
export const SESSION_STATUS = Object.freeze({
  NO_KEYSTORE: "NO_KEYSTORE",
  LOCKED: "LOCKED",
  UNLOCKING: "UNLOCKING",
  INITIALIZING: "INITIALIZING",
  UNLOCKED: "UNLOCKED",
  LOCKING: "LOCKING",
});

export class SessionStore {
  constructor({ bus } = {}) {
    this._bus = bus || null;
    this._state = {
      status: SESSION_STATUS.NO_KEYSTORE,
      error: null,
      accountId: null,
      deviceId: null,
      localInboxId: null,
      ownerAccountId: null,
      initStep: null,
      accountList: [],
      selectedAccountId: null,
      canAddAccount: true,
    };
    this._handlers = new Set();
  }

  snapshot() {
    return { ...this._state };
  }

  // ---- Typed identity accessors ------------------------------------------
  // The session snapshot exposes TWO distinct identities. Callers must use
  // the right one for the right question; the raw field names are a known
  // foot-gun (see project_identity_layers). These accessors are the
  // canonical way to ask for "who am I" in a given context.

  // The peerlink / chat-server owner account. Used everywhere group
  // membership, message authorship, and reactions are keyed. THIS is the
  // id that domain methods (e.g. GroupStore.isSelfAdmin) consult.
  chatAccountId() {
    const v = this._state.ownerAccountId;
    return typeof v === "string" && v.length > 0 ? v : null;
  }

  // The keystore / vault account. Used by auth + keystore directives.
  // NOT the same as chatAccountId — do not pass into group/message APIs.
  vaultAccountId() {
    const v = this._state.accountId;
    return typeof v === "string" && v.length > 0 ? v : null;
  }

  // True if `id` matches any known self-identity slot (vault, peerlink,
  // local inbox, selected account). Collapses the previous `collectSelfIds`
  // helper in presenters/labels.js — same logic, single source.
  isSelf(id) {
    const target = String(id || "").trim();
    if (!target) return false;
    const slots = [
      this._state.accountId,
      this._state.ownerAccountId,
      this._state.localInboxId,
      this._state.selectedAccountId,
    ];
    for (const slot of slots) {
      if (slot && String(slot).trim() === target) return true;
    }
    const accountList = Array.isArray(this._state.accountList) ? this._state.accountList : [];
    for (const entry of accountList) {
      const hint = entry && entry.accountIdHint;
      if (hint && String(hint).trim() === target) return true;
    }
    return false;
  }

  isUnlocked() {
    return this._state.status === SESSION_STATUS.UNLOCKED;
  }

  deviceId() {
    const v = this._state.deviceId;
    return typeof v === "string" && v.length > 0 ? v : null;
  }

  localInboxId() {
    const v = this._state.localInboxId;
    return typeof v === "string" && v.length > 0 ? v : null;
  }

  // ---- Self-chrome accessors --------------------------------------------
  // Used by sidebar/profile/login/splash views so they don't have to read
  // raw snapshot() fields or run their own `accountList.find(...)` loops.

  status() {
    return String(this._state.status || SESSION_STATUS.NO_KEYSTORE);
  }

  error() {
    const v = this._state.error;
    return typeof v === "string" && v.length > 0 ? v : null;
  }

  initStep() {
    const v = this._state.initStep;
    return typeof v === "string" && v.length > 0 ? v : null;
  }

  // Snapshot copy of the account-picker list. Returns [] if none.
  accountList() {
    const list = Array.isArray(this._state.accountList) ? this._state.accountList : [];
    return list.slice();
  }

  // The raw selected slot — may be null even when unlocked (e.g. before a
  // user explicitly picks an account).
  selectedAccountIdRaw() {
    const v = this._state.selectedAccountId;
    return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
  }

  // The id chrome should hang an avatar / id-pill off. Prefers the explicit
  // selection, falls back to the vault account id.
  selectedOrVaultAccountId() {
    const sel = this._state.selectedAccountId;
    if (typeof sel === "string" && sel.trim().length > 0) return sel.trim();
    const vault = this._state.accountId;
    if (typeof vault === "string" && vault.trim().length > 0) return vault.trim();
    return null;
  }

  // The accountList entry whose `id` (or `accountIdHint`) matches the given
  // accountId. Returns null when no row matches.
  accountEntry(accountId) {
    const target = String(accountId || "").trim();
    if (!target) return null;
    const list = Array.isArray(this._state.accountList) ? this._state.accountList : [];
    for (const entry of list) {
      if (!entry || typeof entry !== "object") continue;
      const rowId = String(entry.id || "").trim();
      const hint = String(entry.accountIdHint || "").trim();
      if (rowId === target || hint === target) return entry;
    }
    return null;
  }

  // The accountList entry matching the currently-selected slot (selected
  // first, then vault-account hint).
  selectedAccountEntry() {
    const selected = this._state.selectedAccountId;
    const vault = this._state.accountId;
    const target = (typeof selected === "string" && selected.trim().length > 0)
      ? selected.trim()
      : (typeof vault === "string" && vault.trim().length > 0 ? vault.trim() : "");
    if (!target) return null;
    return this.accountEntry(target);
  }

  // accountList rows other than the selected one — used by the login switch
  // list. Order preserved.
  otherAccountEntries() {
    const list = Array.isArray(this._state.accountList) ? this._state.accountList : [];
    const selectedId = this.selectedAccountIdRaw();
    const out = [];
    for (const entry of list) {
      if (!entry || typeof entry !== "object") continue;
      const rowId = String(entry.id || "").trim();
      if (selectedId && rowId === selectedId) continue;
      out.push(entry);
    }
    return out;
  }

  // The display label for the active self account from accountList, or null
  // if no matching row exposes a non-empty label.
  selfLabel() {
    const entry = this.selectedAccountEntry();
    if (!entry || typeof entry !== "object") return null;
    const label = String(entry.label || "").trim();
    return label || null;
  }

  // Lookup the accountList label for any account id.
  labelForAccountId(accountId) {
    const entry = this.accountEntry(accountId);
    if (!entry || typeof entry !== "object") return null;
    const label = String(entry.label || "").trim();
    return label || null;
  }

  onChange(handler) {
    if (typeof handler !== "function") return () => {};
    this._handlers.add(handler);
    return () => this._handlers.delete(handler);
  }

  _emit(type, keys = {}, meta = {}) {
    const evt = { store: "session", type, keys, meta };
    for (const h of this._handlers) try { h(evt); } catch (err) {
      console.error("[SessionStore] handler threw", err);
      if (this._bus) this._bus.emit("app.error", { source: "SessionStore", message: "handler threw", severity: "error", err });
    }
  }

  setNoKeystore() {
    this._state.status = SESSION_STATUS.NO_KEYSTORE;
    this._state.error = null;
    this._state.accountId = null;
    this._state.deviceId = null;
    this._state.localInboxId = null;
    this._state.ownerAccountId = null;
    this._state.accountList = [];
    this._state.selectedAccountId = null;
    this._emit("session.noKeystore");
  }

  setLocked({ error = null } = {}) {
    this._state.status = SESSION_STATUS.LOCKED;
    this._state.error = error != null ? String(error) : null;
    this._state.accountId = null;
    this._state.deviceId = null;
    this._state.localInboxId = null;
    this._state.ownerAccountId = null;
    this._state.initStep = null;
    this._emit("session.locked");
  }

  setUnlocking() {
    this._state.status = SESSION_STATUS.UNLOCKING;
    this._state.error = null;
    this._emit("session.unlocking");
  }

  setInitializing({ accountId, deviceId, localInboxId = null, ownerAccountId = null } = {}) {
    this._state.status = SESSION_STATUS.INITIALIZING;
    this._state.error = null;
    this._state.initStep = null;
    this._state.accountId = accountId != null ? String(accountId) : null;
    this._state.deviceId = deviceId != null ? String(deviceId) : null;
    this._state.localInboxId = localInboxId != null ? String(localInboxId) : null;
    this._state.ownerAccountId = ownerAccountId != null ? String(ownerAccountId) : null;
    this._emit("session.initializing");
  }

  setInitStep(step) {
    this._state.initStep = step != null ? String(step) : null;
    this._emit("session.initStepChanged");
  }

  setUnlocked({ accountId, deviceId, localInboxId = null, ownerAccountId = null } = {}) {
    this._state.status = SESSION_STATUS.UNLOCKED;
    this._state.error = null;
    this._state.initStep = null;
    this._state.accountId = accountId != null ? String(accountId) : null;
    this._state.deviceId = deviceId != null ? String(deviceId) : null;
    this._state.localInboxId = localInboxId != null ? String(localInboxId) : null;
    this._state.ownerAccountId = ownerAccountId != null ? String(ownerAccountId) : null;
    this._emit("session.unlocked", { accountId: this._state.accountId });
  }

  setLocking() {
    this._state.status = SESSION_STATUS.LOCKING;
    this._emit("session.locking");
  }

  setError(error) {
    this._state.error = error != null ? String(error) : null;
    this._emit("session.errorChanged");
  }

  setAccountList(accountList) {
    this._state.accountList = Array.isArray(accountList) ? accountList : [];
    this._emit("session.accountListChanged");
  }

  setSelectedAccountId(selectedAccountId) {
    this._state.selectedAccountId =
      selectedAccountId != null && String(selectedAccountId).trim() !== ""
        ? String(selectedAccountId).trim()
        : null;
    this._emit("session.selectedAccountChanged");
  }

  setCanAddAccount(canAddAccount) {
    this._state.canAddAccount = !!canAddAccount;
    this._emit("session.canAddAccountChanged");
  }
}
