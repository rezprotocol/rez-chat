import { StoreBase } from "./StoreBase.js";
import { ChatContact, nonEmptyString } from "../../records/index.js";

function asRecord(value) {
  if (value instanceof ChatContact) return value;
  try {
    return new ChatContact(value);
  } catch (err) {
    console.warn("[ContactStore] dropped malformed contact row:", err && err.message ? err.message : err);
    return null;
  }
}

export class ContactStore extends StoreBase {
  #contacts;
  #loaded;

  constructor({ bus = null } = {}) {
    super({ storeName: "contacts", defaultSource: "ContactStore", bus });
    this.#contacts = new Map();
    this.#loaded = false;
  }

  reset() {
    this.#contacts.clear();
    this.#loaded = false;
    this._emit("contacts.reset");
  }

  isLoaded() {
    return this.#loaded === true;
  }

  getContacts() {
    return [...this.#contacts.values()];
  }

  getContact(accountId) {
    const id = nonEmptyString(accountId);
    if (!id) return null;
    return this.#contacts.get(id) || null;
  }

  // The avatar file hash for a contact account. Returns "" when the contact
  // is unknown or has no avatar — callers fall back to initials/hue.
  getAvatarHash(accountId) {
    const contact = this.getContact(accountId);
    if (!contact || typeof contact.avatarFileHash !== "string") return "";
    return contact.avatarFileHash;
  }

  replaceContacts(contacts = []) {
    this.#contacts.clear();
    for (const raw of Array.isArray(contacts) ? contacts : []) {
      const record = asRecord(raw);
      if (!record || !record.accountId) continue;
      this.#contacts.set(record.accountId, record);
    }
    this.#loaded = true;
    this._emit("contacts.replaced");
  }

  upsertContact(contact) {
    const record = asRecord(contact);
    if (!record || !record.accountId) return;
    this.#contacts.set(record.accountId, record);
    this._emit("contacts.upserted", { accountId: record.accountId });
  }

  removeContact(accountId) {
    const id = nonEmptyString(accountId);
    if (!id) return;
    if (!this.#contacts.delete(id)) return;
    this._emit("contacts.removed", { accountId: id });
  }

  // Own-data accessors only. Display name resolution (self check + contact
  // lookup) and active/blocked filtering live in
  // src/ui/queries/contactQueries.js.
}
