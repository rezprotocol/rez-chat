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

// Audit P1.2: a staged entry is enumerable the instant it is durable and never
// otherwise — there is no separate index write to tear against. A failed write
// stages NOTHING (atomic), instead of the old torn `{entryExists:true,pending:0}`.
test("staging is atomic — a failed write strands no invisible entry", async () => {
  const m = new Map();
  let failNextSet = false;
  const kv = {
    async get(k) { return m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : undefined; },
    async set(k, v) {
      if (failNextSet) { failNextSet = false; throw new Error("kv set boom"); }
      m.set(k, JSON.parse(JSON.stringify(v)));
    },
    async delete(k) { return m.delete(k); },
  };
  const ob = new InboundApplyOutbox({ kvStore: kv });

  failNextSet = true;
  await assert.rejects(() => ob.stage(MBOX, "seq:5", { a: 1 }), /kv set boom/);
  // The write failed → the entry must NOT exist AND must NOT be enumerable.
  assert.equal(await ob.has(MBOX, "seq:5"), false, "no half-written entry");
  assert.deepEqual(await ob.listPending(MBOX), [], "nothing stranded invisibly");

  // A retry (write now succeeds) stages cleanly and is immediately enumerable.
  assert.equal(await ob.stage(MBOX, "seq:5", { a: 1 }), true);
  assert.equal(await ob.has(MBOX, "seq:5"), true);
  assert.deepEqual((await ob.listPending(MBOX)).map((e) => e.dedupId), ["seq:5"]);
});

test("a fully-drained mailbox leaves no key behind", async () => {
  const m = new Map();
  const kv = {
    async get(k) { return m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : undefined; },
    async set(k, v) { m.set(k, JSON.parse(JSON.stringify(v))); },
    async delete(k) { return m.delete(k); },
  };
  const ob = new InboundApplyOutbox({ kvStore: kv });
  await ob.stage(MBOX, "seq:1", { n: 1 });
  await ob.markApplied(MBOX, "seq:1");
  assert.equal(m.size, 0, "the per-mailbox record is removed once empty");
});
