import { SESSION_STATUS } from "../stores/SessionStore.js";

export const ACCOUNT_SCOPED_STORE_NAMES = Object.freeze([
  "uiState",
  "threads",
  "messages",
  "contacts",
  "connectRequests",
  "groups",
  "channels",
  "invites",
  "connection",
  "notices",
]);

function sessionAccountKey(sessionStore) {
  const snapshot = sessionStore.snapshot();
  if (!snapshot || snapshot.status !== SESSION_STATUS.UNLOCKED) return "";
  const accountId = String(snapshot.accountId == null ? "" : snapshot.accountId).trim();
  const ownerAccountId = String(snapshot.ownerAccountId == null ? "" : snapshot.ownerAccountId).trim();
  return accountId + "\u0000" + ownerAccountId;
}

export class AccountBoundaryService {
  #sessionStore;
  #stores;
  #accountKey;
  #offSession;

  constructor({ sessionStore, stores } = {}) {
    if (!sessionStore || typeof sessionStore.snapshot !== "function" || typeof sessionStore.onChange !== "function") {
      throw new Error("AccountBoundaryService requires sessionStore");
    }
    if (!stores || typeof stores !== "object") {
      throw new Error("AccountBoundaryService requires stores");
    }
    for (const name of ACCOUNT_SCOPED_STORE_NAMES) {
      const store = stores[name];
      if (!store || typeof store.reset !== "function") {
        throw new Error("AccountBoundaryService requires resettable store: " + name);
      }
    }
    this.#sessionStore = sessionStore;
    this.#stores = stores;
    this.#accountKey = sessionAccountKey(sessionStore);
    this.#offSession = null;
  }

  start() {
    if (this.#offSession) return;
    this.#accountKey = sessionAccountKey(this.#sessionStore);
    this.#offSession = this.#sessionStore.onChange(() => this.#handleSessionChange());
  }

  stop() {
    if (!this.#offSession) return;
    this.#offSession();
    this.#offSession = null;
  }

  #handleSessionChange() {
    const nextAccountKey = sessionAccountKey(this.#sessionStore);
    if (nextAccountKey === this.#accountKey) return;
    this.#accountKey = nextAccountKey;
    for (const name of ACCOUNT_SCOPED_STORE_NAMES) {
      this.#stores[name].reset();
    }
  }
}
