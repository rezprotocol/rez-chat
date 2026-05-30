import test from "node:test";
import assert from "node:assert/strict";
import { ContactStore } from "../../src/ui/stores/ContactStore.js";

test("ContactStore.getContact returns matching record", () => {
  const contacts = new ContactStore();
  contacts.upsertContact({ accountId: "peer_b", displayName: "Bob", relationshipState: "active" });
  const c = contacts.getContact("peer_b");
  assert.equal(c.accountId, "peer_b");
  assert.equal(c.displayName, "Bob");
});

test("ContactStore.getContact returns null for unknown/empty id", () => {
  const contacts = new ContactStore();
  assert.equal(contacts.getContact("peer_unknown"), null);
  assert.equal(contacts.getContact(""), null);
});

test("ContactStore.replaceContacts replaces full set + marks loaded", () => {
  const contacts = new ContactStore();
  contacts.replaceContacts([
    { accountId: "peer_b", displayName: "B", relationshipState: "active" },
    { accountId: "peer_c", displayName: "C", relationshipState: "blocked" },
  ]);
  assert.equal(contacts.isLoaded(), true);
  const ids = contacts.getContacts().map((c) => c.accountId).sort();
  assert.deepEqual(ids, ["peer_b", "peer_c"]);
});

test("ContactStore.removeContact drops entry and emits", () => {
  const contacts = new ContactStore();
  contacts.upsertContact({ accountId: "peer_b", displayName: "B", relationshipState: "active" });
  contacts.removeContact("peer_b");
  assert.equal(contacts.getContact("peer_b"), null);
});

test("ContactStore.getAvatarHash returns the contact's hash or empty string", () => {
  const contacts = new ContactStore();
  contacts.upsertContact({
    accountId: "peer_b",
    displayName: "Bob",
    relationshipState: "active",
    avatarFileHash: "abc123",
  });
  assert.equal(contacts.getAvatarHash("peer_b"), "abc123");
  assert.equal(contacts.getAvatarHash("peer_unknown"), "");
  assert.equal(contacts.getAvatarHash(""), "");
});
