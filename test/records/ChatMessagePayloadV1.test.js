import test from "node:test";
import assert from "node:assert/strict";
import { ChatMessagePayloadV1, CHANNEL_ID_PATTERN, isValidChannelId, GENERAL_CHANNEL_ID } from "../../src/records/payloads/ChatMessagePayloadV1.js";

const BASE = Object.freeze({
  threadId: "thr_1",
  senderAccountId: "acc_alice",
  messageId: "msg_1",
  text: "hi",
});

test("ChatMessagePayloadV1 builds without channelId (defaults to '' = #general)", () => {
  const p = new ChatMessagePayloadV1({ ...BASE });
  assert.equal(p.channelId, GENERAL_CHANNEL_ID);
  assert.equal(p.channelId, "");
});

test("ChatMessagePayloadV1 round-trips channelId through toJSON/fromJSON", () => {
  const p = new ChatMessagePayloadV1({ ...BASE, channelId: "dev" });
  assert.equal(p.channelId, "dev");
  const json = JSON.parse(JSON.stringify(p));
  assert.equal(json.channelId, "dev");
  const restored = new ChatMessagePayloadV1(json);
  assert.equal(restored.channelId, "dev");
});

test("ChatMessagePayloadV1 rejects channelId with disallowed characters", () => {
  assert.throws(() => new ChatMessagePayloadV1({ ...BASE, channelId: "Dev" }));
  assert.throws(() => new ChatMessagePayloadV1({ ...BASE, channelId: "with space" }));
  assert.throws(() => new ChatMessagePayloadV1({ ...BASE, channelId: "name!" }));
});

test("ChatMessagePayloadV1 accepts slug-shaped channelIds", () => {
  for (const id of ["dev", "general", "ops-2026", "alpha_beta", "x", "a1"]) {
    const p = new ChatMessagePayloadV1({ ...BASE, channelId: id });
    assert.equal(p.channelId, id);
  }
});

test("CHANNEL_ID_PATTERN / isValidChannelId helpers", () => {
  assert.ok(CHANNEL_ID_PATTERN.test("dev"));
  assert.ok(!CHANNEL_ID_PATTERN.test(""));
  assert.equal(isValidChannelId(""), false);
  assert.equal(isValidChannelId(null), false);
  assert.equal(isValidChannelId("dev"), true);
  assert.equal(isValidChannelId("DEV"), false);
});

test("ChatMessagePayloadV1 enforces 64-char maxLength on channelId", () => {
  const sixtyFour = "a".repeat(64);
  const sixtyFive = "a".repeat(65);
  const ok = new ChatMessagePayloadV1({ ...BASE, channelId: sixtyFour });
  assert.equal(ok.channelId.length, 64);
  assert.throws(() => new ChatMessagePayloadV1({ ...BASE, channelId: sixtyFive }));
});
