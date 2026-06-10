import { StoreBase } from "./StoreBase.js";
import { nonEmptyString } from "../../records/index.js";

/**
 * ConnectRequestStore (renderer): mirrors the chat-server's pending connect
 * requests so views can distinguish INCOMING (show Approve/Deny) from OUTGOING
 * ("Requested") — a distinction the ContactStore's "invited" relationshipState
 * alone cannot carry. Populated by ContactsService via listConnectRequests and
 * refreshed on the `connectRequest.updated` event. Keyed by peerAccountId.
 */
export class ConnectRequestStore extends StoreBase {
  #byPeer;

  constructor({ bus = null } = {}) {
    super({ storeName: "connectRequests", defaultSource: "ConnectRequestStore", bus });
    this.#byPeer = new Map();
  }

  reset() {
    this.#byPeer.clear();
    this._emit("connectRequests.reset");
  }

  replaceRequests(items = []) {
    this.#byPeer.clear();
    for (const raw of Array.isArray(items) ? items : []) {
      const id = nonEmptyString(raw && raw.peerAccountId);
      if (!id) continue;
      this.#byPeer.set(id, raw);
    }
    this._emit("connectRequests.replaced");
  }

  getRequests() {
    return [...this.#byPeer.values()];
  }

  getByPeer(peerAccountId) {
    const id = nonEmptyString(peerAccountId);
    if (!id) return null;
    return this.#byPeer.get(id) || null;
  }

  getIncoming() {
    return this.getRequests().filter((r) => r && r.direction === "incoming" && r.state === "pending");
  }

  getOutgoing() {
    return this.getRequests().filter((r) => r && r.direction === "outgoing" && r.state === "pending");
  }

  incomingCount() {
    return this.getIncoming().length;
  }
}
