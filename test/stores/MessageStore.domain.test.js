import test from "node:test";
import assert from "node:assert/strict";
import { MessageStore } from "../../src/ui/stores/MessageStore.js";
import { SYSTEM_EVENT_KIND } from "../../src/records/payloads/ChatSystemEventPayloadV1.js";

function makeMsg({ messageId, channelId = null, kind = null, speaker = "peer_b", createdAtMs = 1 } = {}) {
  return {
    messageId,
    threadId: "th_1",
    senderAccountId: speaker,
    speakerId: speaker,
    status: "delivered",
    text: "hi",
    payload: kind != null ? { kind, channelId } : (channelId != null ? { channelId } : null),
    createdAtMs,
  };
}

test("MessageStore.getMessagesFor filters by channelId", () => {
  const messages = new MessageStore();
  messages.replaceMessages("th_1", [
    makeMsg({ messageId: "m1", channelId: "dev" }),
    makeMsg({ messageId: "m2", channelId: "planning" }),
    makeMsg({ messageId: "m3", channelId: "dev" }),
    makeMsg({ messageId: "m4", channelId: null }),
  ]);
  const dev = messages.getMessagesFor("th_1", "dev").map((m) => m.messageId);
  assert.deepEqual(dev, ["m1", "m3"]);
});

test("MessageStore.getMessagesFor general bucket = empty channelId, not 'general'", () => {
  const messages = new MessageStore();
  messages.replaceMessages("th_1", [
    makeMsg({ messageId: "m1", channelId: "dev" }),
    makeMsg({ messageId: "m2", channelId: null }),
    makeMsg({ messageId: "m3", channelId: "general" }),
  ]);
  // GENERAL_CHANNEL_ID = ""; null/undefined/"" all resolve to it.
  // The string "general" is a distinct channel id.
  const general = messages.getMessagesFor("th_1", null).map((m) => m.messageId).sort();
  assert.deepEqual(general, ["m2"]);
  const generalEmpty = messages.getMessagesFor("th_1", "").map((m) => m.messageId).sort();
  assert.deepEqual(generalEmpty, ["m2"]);
  const generalLiteral = messages.getMessagesFor("th_1", "general").map((m) => m.messageId).sort();
  assert.deepEqual(generalLiteral, ["m3"]);
});

test("MessageStore.getMessagesFor includes system events regardless of channel", () => {
  const messages = new MessageStore();
  messages.replaceMessages("th_1", [
    makeMsg({ messageId: "m1", channelId: "dev" }),
    makeMsg({ messageId: "m2", kind: SYSTEM_EVENT_KIND, channelId: null }),
    makeMsg({ messageId: "m3", channelId: "planning" }),
  ]);
  const dev = messages.getMessagesFor("th_1", "dev").map((m) => m.messageId).sort();
  assert.deepEqual(dev, ["m1", "m2"]);
});
