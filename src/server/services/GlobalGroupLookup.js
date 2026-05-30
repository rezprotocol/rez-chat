import { GROUP_PREFIX, GROUP_INDEX_PREFIX } from "../storage/ChatGroupStore.js";

export class GlobalGroupLookup {
  #groupStore;

  constructor({ groupStore } = {}) {
    if (!groupStore || typeof groupStore.getGroup !== "function") {
      throw new Error("GlobalGroupLookup requires groupStore");
    }
    this.#groupStore = groupStore;
  }

  async resolveOwnerByGroupId(groupId) {
    const id = typeof groupId === "string" ? groupId.trim() : "";
    if (!id) return { exists: false };

    const kv = this.#groupStore.kv;
    if (!kv || typeof kv.keys !== "function") return { exists: false };

    // Fast path: check reverse index
    const indexEntry = await kv.get(GROUP_INDEX_PREFIX + id);
    if (indexEntry && typeof indexEntry === "object") {
      const ownerAccountId = typeof indexEntry.ownerAccountId === "string"
        ? indexEntry.ownerAccountId.trim() : "";
      if (ownerAccountId) {
        const group = await this.#groupStore.getGroup({ ownerAccountId, groupId: id });
        if (group) {
          return { exists: true, ownerAccountId };
        }
      }
    }

    // Slow path: prefix scan + backfill
    const keys = await kv.keys(GROUP_PREFIX);
    for (const key of keys) {
      const raw = await kv.get(key);
      if (!raw || typeof raw !== "object") continue;
      if (String(raw.groupId || "").trim() !== id) continue;
      const ownerAccountId = String(raw.accountId || "").trim();
      if (ownerAccountId) {
        // Backfill reverse index
        await kv.set(GROUP_INDEX_PREFIX + id, { ownerAccountId, groupId: id });
        return { exists: true, ownerAccountId };
      }
      return { exists: true };
    }

    return { exists: false };
  }
}
