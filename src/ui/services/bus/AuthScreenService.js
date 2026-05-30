import { BaseBusService } from "./BaseBusService.js";
import { SESSION_STATUS } from "../../stores/SessionStore.js";

function readAccountListLength(sessionStore) {
  const snap = sessionStore && typeof sessionStore.snapshot === "function"
    ? sessionStore.snapshot()
    : {};
  return Array.isArray(snap && snap.accountList) ? snap.accountList.length : 0;
}

export class AuthScreenService extends BaseBusService {
  constructor({ bus, sessionStore, uiStateStore } = {}) {
    super({ bus });
    if (!sessionStore || !uiStateStore) {
      throw new Error("AuthScreenService requires sessionStore and uiStateStore");
    }
    this._sessionStore = sessionStore;
    this._uiStateStore = uiStateStore;
    this._storeOffs = [];
    this._manualScreen = null;
    this._register("authScreen", "showCreate", () => this.showCreate());
    this._register("authScreen", "showUnlock", () => this.showUnlock());
    this._register("authScreen", "get", () => this.getScreen());
    const off = this._sessionStore.onChange(() => this._syncFromSession());
    if (typeof off === "function") {
      this._storeOffs.push(off);
    }
    this._syncFromSession();
  }

  showCreate() {
    this._manualScreen = "create";
    this._uiStateStore.setAuthScreen("create");
    return this.getScreen();
  }

  showUnlock() {
    this._manualScreen = "unlock";
    this._uiStateStore.setAuthScreen("unlock");
    return this.getScreen();
  }

  getScreen() {
    const snap = this._uiStateStore && typeof this._uiStateStore.snapshot === "function"
      ? this._uiStateStore.snapshot()
      : {};
    return String(snap && snap.authScreen || "unlock");
  }

  _syncFromSession() {
    const snap = this._sessionStore && typeof this._sessionStore.snapshot === "function"
      ? this._sessionStore.snapshot()
      : {};
    const status = String(snap && snap.status || "");
    const accountListLength = readAccountListLength(this._sessionStore);
    if (status === SESSION_STATUS.NO_KEYSTORE || accountListLength === 0) {
      this._manualScreen = null;
      this._uiStateStore.setAuthScreen("create");
      return;
    }
    if (status === SESSION_STATUS.UNLOCKED || status === SESSION_STATUS.LOCKING) {
      this._manualScreen = null;
      this._uiStateStore.setAuthScreen("unlock");
      return;
    }
    if (status === SESSION_STATUS.LOCKED || status === SESSION_STATUS.UNLOCKING || status === SESSION_STATUS.INITIALIZING) {
      if (this._manualScreen === "create") {
        this._uiStateStore.setAuthScreen("create");
        return;
      }
      this._uiStateStore.setAuthScreen("unlock");
    }
  }

  stop() {
    for (const off of this._storeOffs.splice(0)) {
      try {
        off();
      } catch {
        // ignore teardown failures
      }
    }
    super.stop();
  }
}
