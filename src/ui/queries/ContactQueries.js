import { nonEmptyString } from "../../records/index.js";

/**
 * ContactQueries: cross-store contact-domain answers.
 *
 * ContactStore stays a simple data store (own contacts); anything that
 * needs self-correlation or active/blocked policy lives here.
 */
export class ContactQueries {
  #stores;

  constructor({ stores } = {}) {
    if (!stores) throw new Error("ContactQueries requires { stores }");
    this.#stores = stores;
  }

  // Resolve a display name for any account id. Order: session "self" check
  // → contact.displayName → null. Returns null when nothing better than
  // the raw id is known — pure display layer can fall back to short-id.
  displayName(accountId) {
    const id = nonEmptyString(accountId);
    if (!id) return null;
    const session = this.#stores.session;
    if (session && typeof session.isSelf === "function" && session.isSelf(id)) {
      return "You";
    }
    const contacts = this.#stores.contacts;
    if (!contacts || typeof contacts.getContact !== "function") return null;
    const contact = contacts.getContact(id);
    if (contact && contact.displayName) return contact.displayName;
    return null;
  }

  activeContacts() {
    const contacts = this.#stores.contacts;
    if (!contacts || typeof contacts.getContacts !== "function") return [];
    const out = [];
    for (const c of contacts.getContacts()) {
      if (c && c.relationshipState !== "blocked") out.push(c);
    }
    return out;
  }

  blockedContacts() {
    const contacts = this.#stores.contacts;
    if (!contacts || typeof contacts.getContacts !== "function") return [];
    const out = [];
    for (const c of contacts.getContacts()) {
      if (c && c.relationshipState === "blocked") out.push(c);
    }
    return out;
  }
}
