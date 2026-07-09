import test from "node:test";
import assert from "node:assert/strict";
import {
  AccountStateEventPayloadV1,
  ACCOUNT_STATE_EVENT_KIND,
  ACCOUNT_STATE_OPS,
} from "../../src/records/payloads/AccountStateEventPayloadV1.js";

const BASE = Object.freeze({
  lamport: 1,
  originDeviceId: "rez:dev:" + "a".repeat(64),
  originDevicePublicKeyB64: "devPubB64",
  issuedAtMs: 1_700_000_000_000,
  sig: "sigB64",
});

test("builds + round-trips each op through toJSON", () => {
  const cases = {
    // The rich contact.upsert carries the whole relationship atomically.
    "contact.upsert": { accountId: "rez:acct:carol", relationshipState: "active", displayName: "Carol", peerInboxId: "inbox:carol", peerLinkId: "pl_1", threadId: "th_1" },
    "contact.remove": { accountId: "rez:acct:carol" },
  };
  for (const [op, payload] of Object.entries(cases)) {
    const e = new AccountStateEventPayloadV1({ ...BASE, op, payload });
    assert.equal(e.kind, ACCOUNT_STATE_EVENT_KIND, op + " carries the discriminator kind");
    assert.equal(e.op, op);
    const json = JSON.parse(JSON.stringify(e));
    assert.equal(json.kind, ACCOUNT_STATE_EVENT_KIND);
    assert.deepEqual(json.payload, payload);
    const restored = new AccountStateEventPayloadV1(json);
    assert.equal(restored.op, op);
    assert.deepEqual(restored.payload, payload);
  }
});

test("GATE BYPASS: the wire form carries NO senderAccountId and NO threadId", () => {
  const e = new AccountStateEventPayloadV1({
    ...BASE, op: "contact.upsert", payload: { accountId: "rez:acct:carol", relationshipState: "active" },
    senderAccountId: "rez:acct:should-be-dropped", threadId: "th_should-be-dropped",
  });
  const json = JSON.parse(JSON.stringify(e));
  assert.equal(json.senderAccountId, undefined, "no senderAccountId field survives");
  assert.equal(json.threadId, undefined, "no threadId field survives");
});

test("rejects an unknown op", () => {
  assert.throws(() => new AccountStateEventPayloadV1({ ...BASE, op: "contact.explode", payload: { accountId: "x" } }));
});

test("rejects a missing required op-payload field", () => {
  // contact.upsert requires relationshipState
  assert.throws(() => new AccountStateEventPayloadV1({
    ...BASE, op: "contact.upsert", payload: { accountId: "rez:acct:carol" },
  }));
  // contact.remove requires accountId
  assert.throws(() => new AccountStateEventPayloadV1({
    ...BASE, op: "contact.remove", payload: {},
  }));
});

test("rejects a non-rez:dev originDeviceId and a non-positive lamport", () => {
  const payload = { accountId: "rez:acct:carol", relationshipState: "active" };
  assert.throws(() => new AccountStateEventPayloadV1({ ...BASE, originDeviceId: "not-a-device", op: "contact.upsert", payload }));
  assert.throws(() => new AccountStateEventPayloadV1({ ...BASE, lamport: 0, op: "contact.upsert", payload }));
});

test("ACCOUNT_STATE_OPS is the exact op vocabulary", () => {
  assert.deepEqual([...ACCOUNT_STATE_OPS], ["contact.upsert", "contact.remove"]);
});
