import { BaseBusService } from "./BaseBusService.js";
import { nonEmptyString } from "../../../records/index.js";

export class ContactsService extends BaseBusService {
  constructor({ bus, contactStore } = {}) {
    super({ bus });
    if (!contactStore) throw new Error("ContactsService requires contactStore");
    this._contactStore = contactStore;
    this._register("contacts", "ensureList", (payload) => this.ensureList(payload));
    this._register("contacts", "get", (payload) => this.get(payload));
    this._register("contacts", "rename", (payload) => this.rename(payload));
    this._register("contacts", "block", (payload) => this.block(payload));
    this._register("contacts", "unblock", (payload) => this.unblock(payload));
    this._register("contacts", "delete", (payload) => this.deleteContact(payload));
    this._listen("runtime.event.contact.updated", (record) => this._handleContactUpdated(record));
  }

  _getClient() {
    return this.bus.runtime && this.bus.runtime.client ? this.bus.runtime.client : null;
  }

  async ensureList({ force = false } = {}) {
    const client = this._getClient();
    if (!client) return this._contactStore.getContacts();
    if (!force && this._contactStore.isLoaded()) {
      return this._contactStore.getContacts();
    }
    const result = await client.call("contacts.list", {});
    const items = result && Array.isArray(result.items) ? result.items : [];
    this._contactStore.replaceContacts(items);
    this.bus.emit("contacts.updated", {});
    return this._contactStore.getContacts();
  }

  get({ accountId } = {}) {
    return this._contactStore.getContact(accountId);
  }

  async rename({ accountId, displayName } = {}) {
    const client = this._getClient();
    const id = nonEmptyString(accountId);
    if (!client || !id) return null;
    const result = await client.call("contacts.rename", { accountId: id, displayName });
    const contact = result && result.contact ? result.contact : null;
    if (contact) this._contactStore.upsertContact(contact);
    return this._contactStore.getContacts();
  }

  async block({ accountId } = {}) {
    const client = this._getClient();
    const id = nonEmptyString(accountId);
    if (!client || !id) return null;
    const result = await client.call("contacts.block", { accountId: id });
    const contact = result && result.contact ? result.contact : null;
    if (contact) this._contactStore.upsertContact(contact);
    return this._contactStore.getContacts();
  }

  async unblock({ accountId } = {}) {
    const client = this._getClient();
    const id = nonEmptyString(accountId);
    if (!client || !id) return null;
    const result = await client.call("contacts.unblock", { accountId: id });
    const contact = result && result.contact ? result.contact : null;
    if (contact) this._contactStore.upsertContact(contact);
    return this._contactStore.getContacts();
  }

  async deleteContact({ accountId } = {}) {
    const client = this._getClient();
    const id = nonEmptyString(accountId);
    if (!client || !id) return null;
    const result = await client.call("contacts.delete", { accountId: id });
    if (result && result.deleted) {
      this._contactStore.removeContact(id);
      this.bus.emit("contacts.updated", {});
    }
    return result;
  }

  _handleContactUpdated(record) {
    const contact = record && record.contact ? record.contact : record;
    if (!contact) return;
    this._contactStore.upsertContact(contact);
    this.bus.emit("contacts.updated", {
      accountId: nonEmptyString(contact && contact.accountId),
    });
  }
}
