import test from "node:test";
import assert from "node:assert/strict";
import { ChatThread } from "../../src/records/domain/ChatThread.js";

test("ChatThread constructs from valid input", () => {
  const r = new ChatThread({ threadId: "th_abc123", title: "Test" });
  assert.equal(r.threadId, "th_abc123");
  assert.equal(r.title, "Test");
  assert.equal(r.threadType, "direct");
  assert.equal(r.visibilityState, "visible");
  assert.equal(r.accessState, "open");
});

test("ChatThread throws when threadId missing", () => {
  assert.throws(() => new ChatThread({ title: "No id" }));
});

test("ChatThread accepts explicit group threadType", () => {
  const r = new ChatThread({ threadId: "th_1", threadType: "group", groupId: "g_1" });
  assert.equal(r.threadType, "group");
});

test("ChatThread is frozen", () => {
  const r = new ChatThread({ threadId: "th_1", title: "T" });
  assert.ok(Object.isFrozen(r));
});

test("ChatThread does not infer peerAccountId from title", () => {
  const r = new ChatThread({
    threadId: "th_dm1",
    threadType: "direct",
    title: "rez:acct:abc123",
  });
  assert.equal(r.threadType, "direct");
  assert.equal(r.peerAccountId, "");
});

test("ChatThread dedupes and trims participant ids", () => {
  const r = new ChatThread({
    threadId: "th_group1",
    threadType: "group",
    participants: ["rez:acct:alice", " rez:acct:bob ", "rez:acct:alice", "", null],
  });
  assert.deepEqual(r.participants, ["rez:acct:alice", "rez:acct:bob"]);
});

test("ChatThread normalizes lifecycle state fields", () => {
  const r = new ChatThread({
    threadId: "th_stateful",
    visibilityState: "hidden",
    accessState: "locked",
  });
  assert.equal(r.visibilityState, "hidden");
  assert.equal(r.accessState, "locked");
});
