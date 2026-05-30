import { asInt, requireId } from "./coerce.js";
import { KvTable } from "./KvTable.js";
import { ChatContact, coerceRelationshipState } from "../../records/domain/ChatContact.js";

function sortByUpdatedThenAccount(list) {
  return list.sort((a, b) => {
    if (a.updatedAtMs !== b.updatedAtMs) return b.updatedAtMs - a.updatedAtMs;
    return String(a.accountId || "").localeCompare(String(b.accountId || ""));
  });
}

export class ContactStore {
  constructor({ storageProvider, clock = () => Date.now() } = {}) {
    if (!storageProvider || typeof storageProvider.getKeyValueStore !== "function") {
      throw new Error("ContactStore requires storageProvider.getKeyValueStore()");
    }
    if (typeof clock !== "function") {
      throw new Error("ContactStore requires clock function");
    }
    this.kv = storageProvider.getKeyValueStore(null);
    this.clock = clock;
    this.contacts = new KvTable({
      kv: this.kv,
      prefix: "app:contacts/",
      record: ChatContact,
      label: "ChatContactStore",
      clock,
    });
  }

  async get({ ownerAccountId, accountId } = {}) {
    const owner = requireId(ownerAccountId, "ownerAccountId");
    const contact = requireId(accountId, "accountId");
    return this.contacts.get(owner, contact);
  }

  async upsert({ ownerAccountId, accountId, patch = {} } = {}) {
    const owner = requireId(ownerAccountId, "ownerAccountId");
    const contact = requireId(accountId, "accountId");
    const existing = await this.get({ ownerAccountId: owner, accountId: contact });
    const now = asInt(this.clock(), Date.now());

    const existingDisplayName = existing && existing.displayName != null ? existing.displayName : null;
    const existingAvatarHash = existing && existing.avatarFileHash;
    const existingRelState = existing && existing.relationshipState;
    const existingCreatedAtMs = existing && existing.createdAtMs != null ? existing.createdAtMs : now;
    const existingLastSeenAtMs = existing && existing.lastSeenAtMs != null ? existing.lastSeenAtMs : null;

    const next = this.contacts.coerce({
      accountId: contact,
      displayName: patch.displayName != null ? patch.displayName : existingDisplayName,
      avatarFileHash: patch.avatarFileHash != null ? patch.avatarFileHash : existingAvatarHash,
      relationshipState: patch.relationshipState != null ? patch.relationshipState : existingRelState,
      createdAtMs: existingCreatedAtMs,
      updatedAtMs: now,
      lastSeenAtMs: patch.lastSeenAtMs == null ? existingLastSeenAtMs : asInt(patch.lastSeenAtMs, now),
    });
    if (!next) {
      throw new Error("ChatContactStore.upsert produced invalid contact row");
    }

    await this.contacts.set(next, owner, contact);
    return { contact: next, created: !existing };
  }

  async ensureContact({ ownerAccountId, accountId, defaults = {} } = {}) {
    const existing = await this.get({ ownerAccountId, accountId });
    if (existing) return { contact: existing, created: false };
    return this.upsert({
      ownerAccountId,
      accountId,
      patch: {
        displayName: defaults.displayName == null ? null : defaults.displayName,
        avatarFileHash: defaults.avatarFileHash == null ? null : defaults.avatarFileHash,
        relationshipState: defaults.relationshipState == null ? "active" : defaults.relationshipState,
        lastSeenAtMs: defaults.lastSeenAtMs == null ? null : defaults.lastSeenAtMs,
      },
    });
  }

  async rename({ ownerAccountId, accountId, displayName } = {}) {
    return this.upsert({ ownerAccountId, accountId, patch: { displayName } });
  }

  async setRelationshipState({ ownerAccountId, accountId, relationshipState } = {}) {
    const nextState = coerceRelationshipState(relationshipState, "active");
    return this.upsert({ ownerAccountId, accountId, patch: { relationshipState: nextState } });
  }

  async listByState({ ownerAccountId, relationshipState } = {}) {
    const owner = requireId(ownerAccountId, "ownerAccountId");
    const state = coerceRelationshipState(relationshipState, "active");
    const all = await this.contacts.list(owner);
    return sortByUpdatedThenAccount(all.filter((row) => row.relationshipState === state));
  }

  async listAll({ ownerAccountId } = {}) {
    const owner = requireId(ownerAccountId, "ownerAccountId");
    return sortByUpdatedThenAccount(await this.contacts.list(owner));
  }
}
