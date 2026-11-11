import test from "node:test";
import assert from "node:assert/strict";
import { createDefaultStorageProvider } from "@rezprotocol/sdk/client";
import { FileManifestV1, FileChunkV1 } from "@rezprotocol/sdk/filetransfer";
import { FileSendParams, FileGetParams } from "../src/records/index.js";
import { ServerFileTransferService } from "../src/server/services/ServerFileTransferService.js";
import { ChatFileManifestV1, ChatFileChunkV1 } from "../src/records/payloads/ChatFilePayloadsV1.js";
import { makeSealDispatch } from "./support/sealDispatchDouble.js";

function fixture(storageProvider = createDefaultStorageProvider()) {
  const sent = []; const completed = []; const handlers = [];
  const bus = { runtime: { sdk: makeSealDispatch() },
    services: { messages: {
      dispatchThreadBytes: async (threadId, bytes) => sent.push(JSON.parse(new TextDecoder().decode(bytes))),
      handleFileBytesReceived: async (manifest, sender, thread) => completed.push([manifest.transferId, sender, thread]),
    } },
    registerFunction: (handler) => handlers.push(handler.namespace + "." + handler.name),
    emit: () => { throw new Error("Byte service must never emit message/status events"); },
  };
  const service = new ServerFileTransferService({ bus, storageProvider, ownerAccountId: "alice" });
  return { service, sent, completed, handlers, bus };
}
const params = (threadId = "th_test") => new FileSendParams({ threadId, channelId: "photos", fileName: "test.png", mimeType: "image/png", fileDataB64: "AQIDBA==", text: "caption belongs to the message" });

test("byte service exposes local get, never owns file.send or a message lifecycle", async () => {
  const f = fixture(); await f.service.start();
  assert.deepEqual(f.handlers, ["file.get"]);
  const result = await f.service.sendFileBytes(params());
  assert.equal(result.messageId, ""); assert.equal(result.fileSizeBytes, 4);
  assert.equal(f.sent.length, 2);
  assert.equal(f.sent[0].messageEnvelope, true);
  assert.equal(f.sent[0].text || "", "", "caption is carried only by the normal image message");
  assert.equal((await f.service.getFile(new FileGetParams({ fileHashHex: result.fileHashHex }))).fileDataB64, "AQIDBA==");
});

test("byte context stays isolated across concurrent sends and a failed send can retry", async () => {
  const f = fixture(); await f.service.start();
  let fail = true;
  const route = f.bus.services.messages.dispatchThreadBytes;
  f.bus.services.messages.dispatchThreadBytes = async (...args) => { if (fail) throw new Error("route down"); return route(...args); };
  await assert.rejects(f.service.sendFileBytes(params()), /route down/);
  fail = false;
  await Promise.all([f.service.sendFileBytes(params("th_first")), f.service.sendFileBytes(params("th_second"))]);
  assert.deepEqual(f.sent.map((body) => body.threadId), ["th_first", "th_first", "th_second", "th_second"]);
});

test("committed partial bytes resume across receiver restart without projecting any message", async () => {
  const sender = fixture(); await sender.service.start();
  await sender.service.sendFileBytes(params());
  const storage = createDefaultStorageProvider();
  const first = fixture(storage); await first.service.start();
  const context = { senderAccountId: "alice", threadId: "th_receiver" };
  await first.service.handleIncomingPayload(new ChatFileManifestV1(sender.sent[0]), context);
  const restarted = fixture(storage); await restarted.service.start();
  await restarted.service.handleIncomingPayload(new ChatFileChunkV1(sender.sent[1]), context);
  assert.deepEqual(restarted.completed, [[sender.sent[0].transferId, "alice", "th_receiver"]]);
  await restarted.service.handleIncomingPayload(new ChatFileChunkV1(sender.sent[1]), context);
  assert.equal(restarted.completed.length, 1);
  assert.ok(new ChatFileManifestV1(sender.sent[0]).manifest instanceof FileManifestV1);
  assert.ok(new ChatFileChunkV1(sender.sent[1]).chunk instanceof FileChunkV1);
});

test("attachment context validates channel and typed byte records", () => {
  assert.throws(() => new ChatFileChunkV1({}), /FileChunk/);
  const f = fixture();
  assert.throws(() => new FileSendParams({ threadId: "", fileDataB64: "AQID", fileName: "x", mimeType: "image/png" }), /threadId/);
  assert.equal(typeof f.service.sendFile, "undefined", "superseded image send path is removed");
});
