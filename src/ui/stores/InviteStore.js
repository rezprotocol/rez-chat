import { StoreBase } from "./StoreBase.js";
import { ChatInvite, nonEmptyString } from "../../records/index.js";

function asRecord(value) {
  if (value instanceof ChatInvite) return value;
  try {
    return new ChatInvite(value);
  } catch (err) {
    console.warn("[InviteStore] dropped malformed invite row:", err && err.message ? err.message : err);
    return null;
  }
}

export class InviteStore extends StoreBase {
  #invitesByCode;
  #lastCreatedInviteCode;

  constructor({ bus = null } = {}) {
    super({ storeName: "invites", defaultSource: "InviteStore", bus });
    this.#invitesByCode = new Map();
    this.#lastCreatedInviteCode = "";
  }

  reset() {
    this.#invitesByCode.clear();
    this.#lastCreatedInviteCode = "";
    this._emit("invites.reset");
  }

  getInvites() {
    return [...this.#invitesByCode.values()];
  }

  getInvite(inviteCode) {
    const code = nonEmptyString(inviteCode);
    if (!code) return null;
    return this.#invitesByCode.get(code) || null;
  }

  replaceInvites(invites = []) {
    this.#invitesByCode.clear();
    for (const raw of Array.isArray(invites) ? invites : []) {
      const record = asRecord(raw);
      if (!record) continue;
      const key = record.inviteCode || record.inviteId;
      if (!key) continue;
      this.#invitesByCode.set(key, record);
    }
    this._emit("invites.replaced");
  }

  upsertInvite(invite) {
    const record = asRecord(invite);
    if (!record) return;
    const key = record.inviteCode || record.inviteId;
    if (!key) return;
    this.#invitesByCode.set(key, record);
    this._emit("invites.upserted", { inviteCode: key });
  }

  getLastCreatedInviteCode() {
    return this.#lastCreatedInviteCode;
  }

  setLastCreatedInviteCode(code) {
    const next = nonEmptyString(code);
    if (next === this.#lastCreatedInviteCode) return;
    this.#lastCreatedInviteCode = next;
    this._emit("invites.lastCreatedInviteCodeChanged", { inviteCode: next });
  }
}
