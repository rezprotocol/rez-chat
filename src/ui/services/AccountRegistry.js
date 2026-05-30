import { AccountRegistryData } from "../records/AccountRegistryData.js";

const REGISTRY_KEY = "rez:account-hints";

function mutableCopy(record) {
  return {
    accountIds: [...record.accountIds],
    hints: { ...record.hints },
  };
}

export class AccountRegistry {
  constructor({ storageProvider } = {}) {
    if (!storageProvider || typeof storageProvider.get !== "function" || typeof storageProvider.put !== "function") {
      throw new Error("AccountRegistry requires storageProvider with get/put");
    }
    this._storage = storageProvider;
  }

  async getRegistry() {
    const raw = await Promise.resolve(this._storage.get(REGISTRY_KEY));
    // Persistent storage is at a trust boundary — fall back to defaults
    // on corruption rather than blocking app boot.
    let record;
    try {
      record = new AccountRegistryData(raw);
    } catch (err) {
      console.warn("[AccountRegistry] invalid registry, using defaults:", err && err.message ? err.message : err);
      record = new AccountRegistryData({});
    }
    return mutableCopy(record);
  }

  async setRegistry(registry) {
    const normalized = new AccountRegistryData(registry);
    await Promise.resolve(this._storage.put(REGISTRY_KEY, normalized.toJSON()));
    return mutableCopy(normalized);
  }

  async listAccounts() {
    const { accountIds, hints } = await this.getRegistry();
    return accountIds.map((id) => ({
      id,
      label: (hints[id] && String(hints[id].label || "").trim()) || "Account",
      accountIdHint: hints[id] && hints[id].accountIdHint ? String(hints[id].accountIdHint).trim() : null,
    }));
  }

  async addAccount(id, label) {
    const reg = await this.getRegistry();
    const trimmedId = String(id || "").trim();
    const trimmedLabel = String(label || "").trim() || "Account";
    if (!trimmedId) throw new Error("AccountRegistry.addAccount requires id");
    if (reg.accountIds.includes(trimmedId)) {
      reg.hints[trimmedId] = { ...reg.hints[trimmedId], label: trimmedLabel };
    } else {
      reg.accountIds.push(trimmedId);
      reg.hints[trimmedId] = { label: trimmedLabel };
    }
    return this.setRegistry(reg);
  }

  async setAccountLabel(id, label) {
    const reg = await this.getRegistry();
    const trimmedId = String(id || "").trim();
    if (!trimmedId || !reg.accountIds.includes(trimmedId)) return reg;
    const trimmedLabel = String(label || "").trim() || "Account";
    reg.hints[trimmedId] = { ...reg.hints[trimmedId], label: trimmedLabel };
    return this.setRegistry(reg);
  }

  async setAccountIdHint(id, accountIdHint) {
    const reg = await this.getRegistry();
    const trimmedId = String(id || "").trim();
    if (!trimmedId || !reg.hints[trimmedId]) return reg;
    reg.hints[trimmedId] = { ...reg.hints[trimmedId], accountIdHint: String(accountIdHint || "").trim() || null };
    return this.setRegistry(reg);
  }
}
