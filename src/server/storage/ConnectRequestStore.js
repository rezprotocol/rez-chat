import { asInt, requireId } from "./coerce.js";
import { KvTable } from "./KvTable.js";
import { ConnectRequest } from "../../records/domain/ConnectRequest.js";

/**
 * ConnectRequestStore: persists pending "connect" requests between group
 * co-members (see ConnectRequest / ConnectRequestPayloadV1). Keyed by
 * peerAccountId so there is at most one live request per peer — a re-sent or
 * glaring request collapses to a single row (last write wins), and the UI's
 * approve/deny acts on the peer it already has in hand.
 */
export class ConnectRequestStore {
  constructor({ storageProvider, clock = () => Date.now() } = {}) {
    if (!storageProvider || typeof storageProvider.getKeyValueStore !== "function") {
      throw new Error("ConnectRequestStore requires storageProvider.getKeyValueStore()");
    }
    if (typeof clock !== "function") {
      throw new Error("ConnectRequestStore requires clock function");
    }
    this.kv = storageProvider.getKeyValueStore(null);
    this.clock = clock;
    this.requests = new KvTable({
      kv: this.kv,
      prefix: "app:connectRequests/",
      record: ConnectRequest,
      label: "ConnectRequestStore",
      clock,
    });
  }

  async get({ ownerAccountId, peerAccountId } = {}) {
    const owner = requireId(ownerAccountId, "ownerAccountId");
    const peer = requireId(peerAccountId, "peerAccountId");
    return this.requests.get(owner, peer);
  }

  async upsert({ ownerAccountId, peerAccountId, direction, requestId, inviteCode = null, displayName = null, groupId = null, state = "pending" } = {}) {
    const owner = requireId(ownerAccountId, "ownerAccountId");
    const peer = requireId(peerAccountId, "peerAccountId");
    const existing = await this.get({ ownerAccountId: owner, peerAccountId: peer });
    const now = asInt(this.clock(), Date.now());
    const next = this.requests.coerce({
      peerAccountId: peer,
      direction,
      requestId,
      inviteCode,
      displayName,
      groupId,
      state,
      createdAtMs: existing && existing.createdAtMs != null ? existing.createdAtMs : now,
      updatedAtMs: now,
    });
    if (!next) {
      throw new Error("ConnectRequestStore.upsert produced invalid request row");
    }
    await this.requests.set(next, owner, peer);
    return { request: next, created: !existing };
  }

  async delete({ ownerAccountId, peerAccountId } = {}) {
    const owner = requireId(ownerAccountId, "ownerAccountId");
    const peer = requireId(peerAccountId, "peerAccountId");
    const existing = await this.get({ ownerAccountId: owner, peerAccountId: peer });
    await this.requests.delete(owner, peer);
    return { deleted: Boolean(existing) };
  }

  async listAll({ ownerAccountId } = {}) {
    const owner = requireId(ownerAccountId, "ownerAccountId");
    const all = await this.requests.list(owner);
    return all.sort((a, b) => b.updatedAtMs - a.updatedAtMs);
  }
}
