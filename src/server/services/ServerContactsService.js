import {
  ContactsBlockParams,
  ContactsBlockResult,
  ContactsDeleteParams,
  ContactsDeleteResult,
  ContactsListParams,
  ContactsListResult,
  ContactsRenameParams,
  ContactsRenameResult,
  ContactsUnblockParams,
  ContactsUnblockResult,
  ContactUpdatedEvent,
} from "../../records/index.js";
import { BaseServerService } from "../base/BaseServerService.js";

export class ServerContactsService extends BaseServerService {
  #contactStore;
  #clock;

  constructor({ bus, contactStore, ownerAccountId, clock = () => Date.now(), logger = console } = {}) {
    super({ bus, ownerAccountId, logger });
    if (!contactStore) {
      throw new Error("ServerContactsService requires contactStore");
    }
    this.#contactStore = contactStore;
    this.#clock = clock;
    this._register("contacts", "list", (payload) => this.listContacts(payload));
    this._register("contacts", "rename", (payload) => this.renameContact(payload));
    this._register("contacts", "block", (payload) => this.blockContact(payload));
    this._register("contacts", "unblock", (payload) => this.unblockContact(payload));
    this._register("contacts", "delete", (payload) => this.deleteContact(payload));
  }

  async ensureActiveContact({ accountId, displayName = "", lastSeenAtMs = null } = {}) {
    if (typeof accountId !== "string" || accountId.trim().length === 0) return null;
    const result = await this.#contactStore.upsert({
      ownerAccountId: this.ownerAccountId,
      accountId,
      patch: {
        relationshipState: "active",
        displayName: displayName || undefined,
        lastSeenAtMs: lastSeenAtMs == null ? this.#clock() : lastSeenAtMs,
      },
    });
    const contact = result && result.contact ? result.contact : null;
    this.#emitContactUpdated(contact);
    return contact;
  }

  async listContacts(payload = {}) {
    this._coerceParams(payload, ContactsListParams);
    const items = await this.#contactStore.listAll({ ownerAccountId: this.ownerAccountId });
    return new ContactsListResult({ items });
  }

  async renameContact(payload = {}) {
    const params = this._coerceParams(payload, ContactsRenameParams);
    const result = await this.#contactStore.rename({
      ownerAccountId: this.ownerAccountId,
      accountId: params.accountId,
      displayName: params.displayName,
    });
    const contact = result && result.contact ? result.contact : null;
    this.#emitContactUpdated(contact);
    return new ContactsRenameResult({ contact });
  }

  async blockContact(payload = {}) {
    const params = this._coerceParams(payload, ContactsBlockParams);
    const result = await this.#contactStore.upsert({
      ownerAccountId: this.ownerAccountId,
      accountId: params.accountId,
      patch: { relationshipState: "blocked" },
    });
    const contact = result && result.contact ? result.contact : null;
    this.#emitContactUpdated(contact);
    return new ContactsBlockResult({ contact });
  }

  async unblockContact(payload = {}) {
    const params = this._coerceParams(payload, ContactsUnblockParams);
    const result = await this.#contactStore.upsert({
      ownerAccountId: this.ownerAccountId,
      accountId: params.accountId,
      patch: { relationshipState: "active" },
    });
    const contact = result && result.contact ? result.contact : null;
    this.#emitContactUpdated(contact);
    return new ContactsUnblockResult({ contact });
  }

  async deleteContact(payload = {}) {
    const params = this._coerceParams(payload, ContactsDeleteParams);
    const result = await this.#contactStore.delete({
      ownerAccountId: this.ownerAccountId,
      accountId: params.accountId,
    });
    return new ContactsDeleteResult({ deleted: result && result.deleted === true });
  }

  #emitContactUpdated(contact) {
    if (!contact || typeof contact !== "object") return;
    this._emit("contact.updated", new ContactUpdatedEvent({ contact }));
  }
}
