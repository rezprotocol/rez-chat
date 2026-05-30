import test from "node:test";
import assert from "node:assert/strict";
import { ThreadStore } from "../../src/ui/stores/ThreadStore.js";

test("ThreadStore.unreadCountFor reads thread.unreadByChannelId", () => {
  const threads = new ThreadStore();
  threads.upsertThread({
    threadId: "th_1",
    threadType: "group",
    groupId: "grp_1",
    accessState: "open",
    unreadCount: 5,
    unreadByChannelId: { "": 2, dev: 3 },
  });
  assert.equal(threads.unreadCountFor("th_1", "dev"), 3);
  assert.equal(threads.unreadCountFor("th_1", ""), 2);
  assert.equal(threads.unreadCountFor("th_1", null), 2);
  assert.equal(threads.unreadCountFor("th_1", "planning"), 0);
});

test("ThreadStore.unreadCountFor falls back to thread.unreadCount for general", () => {
  const threads = new ThreadStore();
  threads.upsertThread({
    threadId: "th_1",
    threadType: "direct",
    peerAccountId: "peer_b",
    peerInboxId: "ibx_b",
    accessState: "open",
    unreadCount: 4,
    unreadByChannelId: {},
  });
  assert.equal(threads.unreadCountFor("th_1", null), 4);
  assert.equal(threads.unreadCountFor("th_1", "dev"), 0);
});

test("ThreadStore.unreadCountFor returns 0 when thread missing", () => {
  const threads = new ThreadStore();
  assert.equal(threads.unreadCountFor("th_missing", "dev"), 0);
});

test("ThreadStore.getThreadByGroupId returns the matching group thread or null", () => {
  const threads = new ThreadStore();
  threads.upsertThread({
    threadId: "th_a",
    threadType: "group",
    groupId: "grp_a",
    accessState: "open",
  });
  threads.upsertThread({
    threadId: "th_b",
    threadType: "direct",
    peerAccountId: "peer_b",
    peerInboxId: "ibx_b",
    accessState: "open",
  });
  assert.equal(threads.getThreadByGroupId("grp_a").threadId, "th_a");
  assert.equal(threads.getThreadByGroupId("grp_missing"), null);
  assert.equal(threads.getThreadByGroupId(""), null);
});
