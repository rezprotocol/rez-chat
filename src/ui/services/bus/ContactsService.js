import { BaseBusService } from "./BaseBusService.js";
import { nonEmptyString } from "../../../records/index.js";

export class ContactsService extends BaseBusService {
  constructor({ bus, contactStore, connectRequestStore = null } = {}) {
    super({ bus });
    if (!contactStore) throw new Error("ContactsService requires contactStore");
    this._contactStore = contactStore;
    this._connectRequestStore = connectRequestStore;
    this._register("contacts", "ensureList", (payload) => this.ensureList(payload));
    this._register("contacts", "get", (payload) => this.get(payload));
    this._register("contacts", "rename", (payload) => this.rename(payload));
    this._register("contacts", "block", (payload) => this.block(payload));
    this._register("contacts", "unblock", (payload) => this.unblock(payload));
    this._register("contacts", "delete", (payload) => this.deleteContact(payload));
    this._register("contacts", "requestConnect", (payload) => this.requestConnect(payload));
    this._register("contacts", "approveConnectRequest", (payload) => this.approveConnectRequest(payload));
    this._register("contacts", "denyConnectRequest", (payload) => this.denyConnectRequest(payload));
    this._register("contacts", "listConnectRequests", () => this.listConnectRequests());
    this._listen("runtime.event.contact.updated", (record) => this._handleContactUpdated(record));
    this._listen("runtime.event.contact.removed", (record) => this._handleContactRemoved(record));
    this._listen("runtime.event.connectRequest.updated", (record) => this._handleConnectRequestUpdated(record));
  }

  _selfLabel() {
    const session = this.bus.stores.session;
    return session && typeof session.selfLabel === "function" ? session.selfLabel() : "";
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
    await this.refreshConnectRequests();
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
    // Fire-and-react: the server deletes the contact (and cascades its DM
    // threads) and emits contact.removed / thread.removed. _handleContactRemoved
    // and ThreadsService._handleThreadRemoved drop the local rows. We do NOT
    // hand-patch the store here — that was the top-down pattern that left
    // dangling thread rows whenever the server removed something on its own.
    return client.call("contacts.delete", { accountId: id });
  }

  // --- Connect requests (group co-member → DM, approve/deny) ---

  async requestConnect({ peerAccountId, groupId = "" } = {}) {
    const client = this._getClient();
    const id = nonEmptyString(peerAccountId);
    if (!client || !id) return null;
    // The server records the outgoing request and upserts the `invited`
    // placeholder contact, emitting contact.updated. _handleContactUpdated
    // upserts it. No ensureList({force:true}) — that full clear-and-refetch was
    // the "wipe the whole list and rebuild" pattern behind the flicker/clear.
    return client.call("contacts.requestConnect", {
      peerAccountId: id,
      displayName: this._selfLabel(),
      groupId: nonEmptyString(groupId),
    });
  }

  async approveConnectRequest({ accountId } = {}) {
    const client = this._getClient();
    const id = nonEmptyString(accountId);
    if (!client || !id) return null;
    // acceptInvite flips the contact to `active` (server emits contact.updated)
    // and the approve drops the request row (connectRequest.updated). Both are
    // reconciled by the listeners. Reacting to those beats the prior
    // ensureList({force:true}) that nuked and rebuilt the entire contact list.
    return client.call("contacts.approveConnectRequest", {
      accountId: id,
      acceptorDisplayName: this._selfLabel(),
    });
  }

  async denyConnectRequest({ accountId } = {}) {
    const client = this._getClient();
    const id = nonEmptyString(accountId);
    if (!client || !id) return null;
    // The server drops the invited placeholder and emits contact.removed +
    // connectRequest.updated; the listeners reconcile the store and the pending
    // list. Mirroring it locally here is what made deny feel like it was
    // imperatively rewriting the whole contact list.
    return client.call("contacts.denyConnectRequest", { accountId: id });
  }

  async listConnectRequests() {
    const client = this._getClient();
    if (!client) return [];
    const result = await client.call("contacts.listConnectRequests", {});
    return result && Array.isArray(result.items) ? result.items : [];
  }

  async refreshConnectRequests() {
    if (!this._connectRequestStore) return [];
    const items = await this.listConnectRequests();
    this._connectRequestStore.replaceRequests(items);
    return items;
  }

  async _handleConnectRequestUpdated(record) {
    const peerAccountId = nonEmptyString(record && record.peerAccountId);
    try {
      await this.refreshConnectRequests();
    } catch (err) {
      console.error("[ContactsService] refreshConnectRequests failed", err);
    }
    // Re-broadcast for any connect-request-aware views to refresh.
    this.bus.emit("connectRequests.updated", { peerAccountId });
  }

  _handleContactUpdated(record) {
    const contact = record && record.contact ? record.contact : record;
    if (!contact) return;
    this._contactStore.upsertContact(contact);
    this.bus.emit("contacts.updated", {
      accountId: nonEmptyString(contact && contact.accountId),
    });
  }

  _handleContactRemoved(record) {
    const accountId = nonEmptyString(record && record.accountId);
    if (!accountId) return;
    this._contactStore.removeContact(accountId);
    this.bus.emit("contacts.updated", { accountId });
  }
}
