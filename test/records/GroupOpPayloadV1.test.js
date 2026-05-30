import test from "node:test";
import assert from "node:assert/strict";
import { GroupOpPayloadV1 } from "../../src/records/payloads/GroupOpPayloadV1.js";

const COMMON = Object.freeze({
  groupId: "grp_1",
  actedAtMs: 1000,
  groupOpId: "op_1",
});

test("GroupOpPayloadV1.rename still validates title", () => {
  const r = new GroupOpPayloadV1({ ...COMMON, op: "rename", title: "Engineering" });
  assert.equal(r.op, "rename");
  assert.equal(r.title, "Engineering");
  assert.throws(() => new GroupOpPayloadV1({ ...COMMON, op: "rename" }));
});

test("GroupOpPayloadV1.channel.create requires non-empty channelId", () => {
  const r = new GroupOpPayloadV1({ ...COMMON, op: "channel.create", channelId: "dev" });
  assert.equal(r.op, "channel.create");
  assert.equal(r.channelId, "dev");
  assert.throws(() => new GroupOpPayloadV1({ ...COMMON, op: "channel.create" }));
  assert.throws(() => new GroupOpPayloadV1({ ...COMMON, op: "channel.create", channelId: "" }));
});

test("GroupOpPayloadV1.channel.delete requires non-empty channelId", () => {
  const r = new GroupOpPayloadV1({ ...COMMON, op: "channel.delete", channelId: "dev" });
  assert.equal(r.op, "channel.delete");
  assert.equal(r.channelId, "dev");
  assert.throws(() => new GroupOpPayloadV1({ ...COMMON, op: "channel.delete" }));
});

test("GroupOpPayloadV1 channel ops reject invalid channelId characters", () => {
  assert.throws(() => new GroupOpPayloadV1({ ...COMMON, op: "channel.create", channelId: "Dev" }));
  assert.throws(() => new GroupOpPayloadV1({ ...COMMON, op: "channel.create", channelId: "has space" }));
});

test("GroupOpPayloadV1 op enum includes the new channel ops", () => {
  const op = new GroupOpPayloadV1({ ...COMMON, op: "channel.create", channelId: "dev" });
  // round-trip through JSON
  const json = JSON.parse(JSON.stringify(op));
  assert.equal(json.op, "channel.create");
  assert.equal(json.channelId, "dev");
  const restored = new GroupOpPayloadV1(json);
  assert.equal(restored.op, "channel.create");
});

test("GroupOpPayloadV1.member.join requires accountId + inviteId", () => {
  const op = new GroupOpPayloadV1({
    ...COMMON, op: "member.join",
    accountId: "rez:acct:bob", inviteId: "plinv_abc",
  });
  assert.equal(op.op, "member.join");
  assert.equal(op.accountId, "rez:acct:bob");
  assert.equal(op.inviteId, "plinv_abc");
  // accountId required
  assert.throws(() => new GroupOpPayloadV1({
    ...COMMON, op: "member.join", inviteId: "plinv_abc",
  }));
  // inviteId required
  assert.throws(() => new GroupOpPayloadV1({
    ...COMMON, op: "member.join", accountId: "rez:acct:bob",
  }));
});

test("GroupOpPayloadV1.member.join round-trips through JSON with displayName", () => {
  const op = new GroupOpPayloadV1({
    ...COMMON, op: "member.join",
    accountId: "rez:acct:bob", inviteId: "plinv_abc", displayName: "Bob",
  });
  const restored = new GroupOpPayloadV1(JSON.parse(JSON.stringify(op)));
  assert.equal(restored.op, "member.join");
  assert.equal(restored.accountId, "rez:acct:bob");
  assert.equal(restored.inviteId, "plinv_abc");
  assert.equal(restored.displayName, "Bob");
});

test("GroupOpPayloadV1.channels.sync_request needs only groupId + actedAtMs + groupOpId", () => {
  const op = new GroupOpPayloadV1({ ...COMMON, op: "channels.sync_request" });
  assert.equal(op.op, "channels.sync_request");
  assert.equal(op.groupId, "grp_1");
  // No channelId required for sync requests.
  assert.equal(op.channelId, "");
  // Round-trip JSON.
  const restored = new GroupOpPayloadV1(JSON.parse(JSON.stringify(op)));
  assert.equal(restored.op, "channels.sync_request");
});
