import test from "node:test";
import assert from "node:assert/strict";
import { CHAT_BRIDGE_SPEC } from "../src/server/transport/ChatBridge.js";
import { FileSendParams, FileSendResult, FileGetParams, FileGetResult } from "../src/records/index.js";

test("CHAT_BRIDGE_SPEC includes file.send method", () => {
  const entry = CHAT_BRIDGE_SPEC.methods["file.send"];
  assert.ok(entry, "file.send should be in methods");
  assert.equal(entry.params, FileSendParams);
  assert.equal(entry.result, FileSendResult);
});

test("CHAT_BRIDGE_SPEC includes file.get method", () => {
  const entry = CHAT_BRIDGE_SPEC.methods["file.get"];
  assert.ok(entry, "file.get should be in methods");
  assert.equal(entry.params, FileGetParams);
  assert.equal(entry.result, FileGetResult);
});

test("FileSendParams round-trip via toJSON/fromJSON", () => {
  const params = new FileSendParams({
    threadId: "th_abc",
    fileDataB64: "AQIDBA==",
    fileName: "photo.jpg",
    mimeType: "image/jpeg",
  });
  const json = params.toJSON();
  const restored = FileSendParams.fromJSON(json);
  assert.equal(restored.threadId, "th_abc");
  assert.equal(restored.fileDataB64, "AQIDBA==");
  assert.equal(restored.fileName, "photo.jpg");
  assert.equal(restored.mimeType, "image/jpeg");
});

test("FileGetParams round-trip via toJSON/fromJSON", () => {
  const hash = "a".repeat(64);
  const params = new FileGetParams({ fileHashHex: hash });
  const json = params.toJSON();
  const restored = FileGetParams.fromJSON(json);
  assert.equal(restored.fileHashHex, hash);
});

test("FileSendResult round-trip via toJSON/fromJSON", () => {
  const result = new FileSendResult({
    threadId: "th_abc",
    messageId: "msg_1",
    fileHashHex: "b".repeat(64),
    transferId: "xfer_1",
  });
  const json = result.toJSON();
  const restored = FileSendResult.fromJSON(json);
  assert.equal(restored.threadId, "th_abc");
  assert.equal(restored.messageId, "msg_1");
  assert.equal(restored.fileHashHex, "b".repeat(64));
  assert.equal(restored.transferId, "xfer_1");
});

test("FileGetResult round-trip via toJSON/fromJSON", () => {
  const result = new FileGetResult({
    fileHashHex: "c".repeat(64),
    fileDataB64: "AQIDBA==",
    mimeType: "image/png",
    fileName: "test.png",
  });
  const json = result.toJSON();
  const restored = FileGetResult.fromJSON(json);
  assert.equal(restored.fileHashHex, "c".repeat(64));
  assert.equal(restored.fileDataB64, "AQIDBA==");
  assert.equal(restored.mimeType, "image/png");
  assert.equal(restored.fileName, "test.png");
});
