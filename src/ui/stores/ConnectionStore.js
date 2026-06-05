import { StoreBase } from "./StoreBase.js";
import { nonEmptyString } from "../../records/index.js";

function clone(connection) {
  const row = connection && typeof connection === "object" ? connection : {};
  return {
    status: nonEmptyString(row.status) || "disconnected",
    lastError: row.lastError == null ? null : String(row.lastError),
    // True once the post-login inbox catch-up has fully drained + applied every
    // missed deposit (server emits inbox.caughtup). Until then the UI shows a
    // "syncing" state instead of asserting the stale pre-catch-up snapshot.
    inboxSynced: row.inboxSynced === true,
    activeNode: nonEmptyString(row.activeNode),
    nodes: Array.isArray(row.nodes)
      ? row.nodes.map((item) => ({ ...(item && typeof item === "object" ? item : {}) }))
      : [],
    mesh: row.mesh && typeof row.mesh === "object" ? { ...row.mesh } : null,
    backup: row.backup && typeof row.backup === "object"
      ? { ...row.backup }
      : {
          enabled: false,
          lastBackupAtMs: null,
          checkpointVersion: null,
          retentionDays: null,
        },
  };
}

export class ConnectionStore extends StoreBase {
  #connection;

  constructor({ bus = null } = {}) {
    super({ storeName: "connection", defaultSource: "ConnectionStore", bus });
    this.#connection = clone();
  }

  reset() {
    this.#connection = clone();
    this._emit("connection.reset");
  }

  getConnection() {
    return clone(this.#connection);
  }

  setConnection(patch = {}) {
    this.#connection = clone({
      ...this.#connection,
      ...(patch && typeof patch === "object" ? patch : {}),
    });
    this._emit("connection.updated");
  }

  // ---- Typed status accessors -------------------------------------------

  isOnline() {
    return this.#connection.status === "connected";
  }

  // True once the post-login inbox catch-up has fully applied every missed
  // deposit. Views gate their "empty"/roster assertions on this so a stale
  // pre-catch-up snapshot is never shown as final.
  isInboxSynced() {
    return this.#connection.inboxSynced === true;
  }

  status() {
    return this.#connection.status;
  }

  lastError() {
    return this.#connection.lastError;
  }
}
