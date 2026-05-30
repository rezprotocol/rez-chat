import test from "node:test";
import assert from "node:assert/strict";
import { ChatMessage } from "../../src/records/domain/ChatMessage.js";

// ChatMessage is the canonical chat-message record. Construction is strict:
// new ChatMessage(raw) throws on missing required fields. No tryCreate, no
// alias fallback, no field synonyms.

test("ChatMessage constructs from valid input", () => {
  const r = new ChatMessage({
    threadId: "th_test",
    messageId: "m1",
    packetB64: "YQ==",
    createdAtMs: 100,
  });
  assert.equal(r.messageId, "m1");
  assert.equal(r.threadId, "th_test");
  assert.equal(r.packetB64, "YQ==");
  assert.equal(r.createdAtMs, 100);
  assert.equal(r.status, "delivered");
});

test("ChatMessage throws when messageId missing", () => {
  assert.throws(() => new ChatMessage({ threadId: "th_test", packetB64: "YQ==" }));
});

test("ChatMessage throws when threadId missing", () => {
  assert.throws(() => new ChatMessage({ messageId: "m1", packetB64: "YQ==" }));
});

test("ChatMessage throws on invalid status", () => {
  assert.throws(() => new ChatMessage({
    threadId: "th_test",
    messageId: "m1",
    status: "bogus",
  }));
});

test("ChatMessage preserves empty packetB64 as empty string", () => {
  const r = new ChatMessage({ threadId: "th_test", messageId: "m1", packetB64: "" });
  assert.equal(r.packetB64, "");
});

test("ChatMessage is frozen", () => {
  const r = new ChatMessage({ threadId: "th_test", messageId: "m1", packetB64: "YQ==" });
  assert.ok(Object.isFrozen(r));
});

test("ChatMessage.speakerId defaults to senderAccountId when not provided", () => {
  const r = new ChatMessage({
    threadId: "th_test",
    messageId: "m1",
    senderAccountId: "rez:acct:alice",
    packetB64: "YQ==",
  });
  assert.equal(r.speakerId, "rez:acct:alice");
  assert.equal(r.inferredNotMine, false);
});

test("ChatMessage.speakerId honors explicit value", () => {
  const r = new ChatMessage({
    threadId: "th_test",
    messageId: "m2",
    senderAccountId: "rez:acct:alice",
    speakerId: "rez:acct:bob",
    inferredNotMine: true,
    packetB64: "YQ==",
  });
  assert.equal(r.speakerId, "rez:acct:bob");
  assert.equal(r.inferredNotMine, true);
});

test("ChatMessage.toJSON round-trips through new ChatMessage", () => {
  const original = new ChatMessage({
    threadId: "th_test",
    messageId: "m1",
    senderAccountId: "rez:acct:alice",
    text: "hello",
    status: "sent",
    createdAtMs: 100,
    acceptedAtMs: 110,
    packetB64: "YQ==",
  });
  const json = original.toJSON();
  const round = new ChatMessage(json);
  assert.equal(round.messageId, original.messageId);
  assert.equal(round.text, original.text);
  assert.equal(round.status, original.status);
  assert.equal(round.createdAtMs, original.createdAtMs);
});
