import test from "node:test";
import assert from "node:assert/strict";
import { ContactStore } from "../../src/ui/stores/ContactStore.js";
import { SessionStore } from "../../src/ui/stores/SessionStore.js";
import { ContactQueries } from "../../src/ui/queries/ContactQueries.js";

function setup() {
  const stores = {
    session: new SessionStore(),
    contacts: new ContactStore(),
  };
  stores.session.setUnlocked({
    accountId: "vault_self",
    deviceId: "dev_self",
    ownerAccountId: "peer_self",
  });
  return { stores, queries: new ContactQueries({ stores }) };
}

test("displayName: 'You' for self ids (both vault and chat)", () => {
  const { queries } = setup();
  assert.equal(queries.displayName("peer_self"), "You");
  assert.equal(queries.displayName("vault_self"), "You");
});

test("displayName: returns contact displayName when set", () => {
  const { stores, queries } = setup();
  stores.contacts.upsertContact({
    accountId: "peer_b",
    displayName: "Bob",
    relationshipState: "active",
  });
  assert.equal(queries.displayName("peer_b"), "Bob");
});

test("displayName: returns null when no name available", () => {
  const { queries } = setup();
  assert.equal(queries.displayName("peer_unknown"), null);
  assert.equal(queries.displayName(""), null);
  assert.equal(queries.displayName(null), null);
});

test("activeContacts excludes blocked", () => {
  const { stores, queries } = setup();
  stores.contacts.upsertContact({ accountId: "peer_b", displayName: "B", relationshipState: "active" });
  stores.contacts.upsertContact({ accountId: "peer_c", displayName: "C", relationshipState: "blocked" });
  stores.contacts.upsertContact({ accountId: "peer_d", displayName: "D", relationshipState: "invited" });
  const ids = queries.activeContacts().map((c) => c.accountId).sort();
  assert.deepEqual(ids, ["peer_b", "peer_d"]);
});

test("blockedContacts returns only blocked", () => {
  const { stores, queries } = setup();
  stores.contacts.upsertContact({ accountId: "peer_b", displayName: "B", relationshipState: "active" });
  stores.contacts.upsertContact({ accountId: "peer_c", displayName: "C", relationshipState: "blocked" });
  const ids = queries.blockedContacts().map((c) => c.accountId);
  assert.deepEqual(ids, ["peer_c"]);
});

test("constructor throws without stores", () => {
  assert.throws(() => new ContactQueries(), /requires \{ stores \}/);
});
