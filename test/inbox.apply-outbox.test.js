import test from "node:test";
import assert from "node:assert/strict";
import { InboundApplyOutbox } from "../src/server/inbox/InboundApplyOutbox.js";

// In-memory KV matching the chat-server KV surface (get/set/delete), deep-cloning
// on read/write so the test exercises real serialization-shaped values.
function makeKv() {
  const m = new Map();
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  return {
    async get(k) { return m.has(k) ? clone(m.get(k)) : undefined; },
    async set(k, v) { m.set(k, clone(v)); },
    async delete(k) { return m.delete(k); },
  };
}

const MBOX = "inbox:a";

test("stage makes a decrypted payload durably retrievable; markApplied removes it", async () => {
  const ob = new InboundApplyOutbox({ kvStore: makeKv() });
  const msg = { threadId: "t1", payload: { kind: "chat.message", text: "hi" } };
  assert.equal(await ob.stage(MBOX, "seq:5", msg), true, "new entry staged");
  assert.equal(await ob.has(MBOX, "seq:5"), true);
  const got = await ob.get(MBOX, "seq:5");
  assert.deepEqual(got.userMessage, msg);
  assert.equal(got.attempts, 0);

  await ob.markApplied(MBOX, "seq:5");
  assert.equal(await ob.has(MBOX, "seq:5"), false, "removed after apply");
  assert.deepEqual(await ob.listPending(MBOX), []);
});

test("stage is idempotent — re-staging preserves attempts + firstStagedAtMs", async () => {
  const ob = new InboundApplyOutbox({ kvStore: makeKv() });
  await ob.stage(MBOX, "seq:5", { a: 1 }, { nowMs: 1000 });
  const f1 = await ob.recordApplyFailure(MBOX, "seq:5", { nowMs: 1100 });
  assert.equal(f1.attempts, 1);

  // A redelivery re-stages — must NOT reset the poison accounting.
  assert.equal(await ob.stage(MBOX, "seq:5", { a: 1 }, { nowMs: 9999 }), false, "no new entry");
  const entry = await ob.get(MBOX, "seq:5");
  assert.equal(entry.attempts, 1, "attempts preserved");
  assert.equal(entry.firstStagedAtMs, 1000, "firstStagedAtMs preserved");
});

test("listPending enumerates staged entries and shrinks as they apply", async () => {
  const ob = new InboundApplyOutbox({ kvStore: makeKv() });
  await ob.stage(MBOX, "seq:1", { n: 1 });
  await ob.stage(MBOX, "seq:2", { n: 2 });
  await ob.stage(MBOX, "seq:3", { n: 3 });
  assert.deepEqual((await ob.listPending(MBOX)).map((e) => e.dedupId).sort(), ["seq:1", "seq:2", "seq:3"]);

  await ob.markApplied(MBOX, "seq:2");
  assert.deepEqual((await ob.listPending(MBOX)).map((e) => e.dedupId).sort(), ["seq:1", "seq:3"]);
});

test("recordApplyFailure increments and returns the poison-bound inputs", async () => {
  const ob = new InboundApplyOutbox({ kvStore: makeKv() });
  await ob.stage(MBOX, "seq:7", { x: 1 }, { nowMs: 500 });
  assert.deepEqual(await ob.recordApplyFailure(MBOX, "seq:7", { nowMs: 600 }), { attempts: 1, firstStagedAtMs: 500 });
  assert.deepEqual(await ob.recordApplyFailure(MBOX, "seq:7", { nowMs: 700 }), { attempts: 2, firstStagedAtMs: 500 });
  // A failure on a non-staged entry is a no-op (already applied/removed).
  assert.deepEqual(await ob.recordApplyFailure(MBOX, "seq:nope"), { attempts: 0, firstStagedAtMs: null });
});

test("pending index is per-mailbox isolated", async () => {
  const ob = new InboundApplyOutbox({ kvStore: makeKv() });
  await ob.stage("inbox:a", "seq:1", { n: 1 });
  await ob.stage("inbox:b", "seq:1", { n: 2 });
  assert.deepEqual((await ob.listPending("inbox:a")).map((e) => e.userMessage.n), [1]);
  assert.deepEqual((await ob.listPending("inbox:b")).map((e) => e.userMessage.n), [2]);
});
