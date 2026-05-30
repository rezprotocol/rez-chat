import test from "node:test";
import assert from "node:assert/strict";
import { MessageStore } from "../../src/ui/stores/MessageStore.js";
import { ContactStore } from "../../src/ui/stores/ContactStore.js";
import { SessionStore } from "../../src/ui/stores/SessionStore.js";
import { MessageQueries } from "../../src/ui/queries/MessageQueries.js";

function setup() {
  const stores = {
    session: new SessionStore(),
    contacts: new ContactStore(),
    messages: new MessageStore(),
  };
  stores.session.setUnlocked({
    accountId: "vault_a",
    deviceId: "dev_a",
    ownerAccountId: "peer_a",
  });
  return { stores, queries: new MessageQueries({ stores }) };
}

function makeMsg({ messageId, speaker = "peer_b", createdAtMs = 1 } = {}) {
  return {
    messageId,
    threadId: "th_1",
    senderAccountId: speaker,
    speakerId: speaker,
    status: "delivered",
    text: "hi",
    createdAtMs,
  };
}

test("isOwnMessage: true for self-credited speakerId", () => {
  const { stores, queries } = setup();
  stores.messages.upsertMessage("th_1", makeMsg({ messageId: "m1", speaker: "peer_a" }));
  stores.messages.upsertMessage("th_1", makeMsg({ messageId: "m2", speaker: "peer_b" }));
  assert.equal(queries.isOwnMessage("th_1", "m1"), true);
  assert.equal(queries.isOwnMessage("th_1", "m2"), false);
});

test("isOwnMessage: false for unknown message", () => {
  const { queries } = setup();
  assert.equal(queries.isOwnMessage("th_1", "missing"), false);
});

test("senderLabel: resolves via ContactStore", () => {
  const { stores, queries } = setup();
  stores.contacts.upsertContact({ accountId: "peer_b", displayName: "Bob", relationshipState: "active" });
  stores.messages.upsertMessage("th_1", makeMsg({ messageId: "m1", speaker: "peer_b" }));
  assert.equal(queries.senderLabel("th_1", "m1"), "Bob");
});

test("senderLabel: 'You' for own messages", () => {
  const { stores, queries } = setup();
  stores.messages.upsertMessage("th_1", makeMsg({ messageId: "m1", speaker: "peer_a" }));
  assert.equal(queries.senderLabel("th_1", "m1"), "You");
});

test("senderLabel: null when no name available", () => {
  const { stores, queries } = setup();
  stores.messages.upsertMessage("th_1", makeMsg({ messageId: "m1", speaker: "peer_unknown" }));
  assert.equal(queries.senderLabel("th_1", "m1"), null);
});

test("constructor throws without stores", () => {
  assert.throws(() => new MessageQueries(), /requires \{ stores \}/);
});
