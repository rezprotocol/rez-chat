import test from "node:test";
import assert from "node:assert/strict";
import { FileSendParams, FileGetParams } from "../src/records/index.js";
import { ServerFileTransferService } from "../src/server/services/ServerFileTransferService.js";
import { ChatImagePayloadV1 } from "../src/records/payloads/ChatImagePayloadV1.js";
import { FileManifestV1, FileChunkV1 } from "@rezprotocol/sdk/filetransfer";
import { makeSealDispatch } from "./support/sealDispatchDouble.js";

class TestKVStore {
  constructor() { this._data = new Map(); }
  get(key) { return this._data.get(key); }
  set(key, value) { this._data.set(key, value); }
  delete(key) { this._data.delete(key); }
  keys(prefix) {
    const out = [];
    for (const k of this._data.keys()) {
      if (k.startsWith(prefix)) out.push(k);
    }
    return out;
  }
}

class TestStorageProvider {
  constructor() { this._stores = new Map(); }
  getKeyValueStore(name) {
    if (!this._stores.has(name)) this._stores.set(name, new TestKVStore());
    return this._stores.get(name);
  }
  getObjectStore() { return { deposit: async () => ({}), list: async () => [] }; }
  getMailboxStore() { return { deposit: async () => ({}), poll: async () => [] }; }
}

const OWNER = "rez:acct:test-owner";

function createBus() {
  const handlers = new Map();
  const events = [];
  return {
    stores: {
      threadStore: {
        getThread: async (threadId) => ({
          threadId,
          peerAccountId: "rez:acct:peer-1",
          peerInboxId: "inbox:peer-1",
          threadType: "direct",
        }),
        recordOutboundDeposit: async () => {},
        upsertDepositedMessage: async () => {},
        setMessageStatus: async () => {},
      },
      threadIndex: {
        upsertFromMessage: async () => ({ threadId: "th_test", updatedAtMs: 1000 }),
      },
    },
    runtime: {
      sdk: {
        ...makeSealDispatch(),
        getIdentity: () => ({ localInboxId: "inbox:test-owner" }),
      },
    },
    services: {
      threads: {
        emitThreadIndexUpdated: () => {},
      },
    },
    registerFunction: ({ namespace, name, fn }) => {
      handlers.set(namespace + "." + name, fn);
    },
    call: (namespace, name, payload) => {
      const fn = handlers.get(namespace + "." + name);
      if (fn) return fn(payload);
      throw new Error("No handler for " + namespace + "." + name);
    },
    on: () => () => {},
    emit: (eventName, payload) => { events.push({ eventName, payload }); },
    _events: events,
    _handlers: handlers,
  };
}

test("FileSendParams validates required fields", () => {
  assert.throws(() => new FileSendParams({ threadId: "", fileDataB64: "abc", fileName: "a.png", mimeType: "image/png" }),
    (err) => { assert.ok(err.message.includes("threadId")); return true; });
  assert.throws(() => new FileSendParams({ threadId: "th_1", fileDataB64: "", fileName: "a.png", mimeType: "image/png" }),
    (err) => { assert.ok(err.message.includes("fileDataB64")); return true; });
  assert.throws(() => new FileSendParams({ threadId: "th_1", fileDataB64: "abc", fileName: "", mimeType: "image/png" }),
    (err) => { assert.ok(err.message.includes("fileName")); return true; });
  assert.throws(() => new FileSendParams({ threadId: "th_1", fileDataB64: "abc", fileName: "a.png", mimeType: "" }),
    (err) => { assert.ok(err.message.includes("mimeType")); return true; });
});

test("FileSendParams rejects oversized data", () => {
  const bigData = "A".repeat(14_000_001);
  assert.throws(() => new FileSendParams({ threadId: "th_1", fileDataB64: bigData, fileName: "a.png", mimeType: "image/png" }),
    (err) => { assert.ok(err.message.includes("exceeds")); return true; });
});

test("FileGetParams validates 64-char hex", () => {
  assert.throws(() => new FileGetParams({ fileHashHex: "short" }),
    (err) => { assert.ok(err.message.includes("64-char hex")); return true; });
  const valid = new FileGetParams({ fileHashHex: "a".repeat(64) });
  assert.equal(valid.fileHashHex, "a".repeat(64));
});

test("ServerFileTransferService registers file.send and file.get on bus", () => {
  const bus = createBus();
  const storage = new TestStorageProvider();
  new ServerFileTransferService({ bus, storageProvider: storage, ownerAccountId: OWNER });
  assert.ok(bus._handlers.has("file.send"));
  assert.ok(bus._handlers.has("file.get"));
});

test("ServerFileTransferService.start() throws without sdk", async () => {
  const bus = createBus();
  bus.runtime = { sdk: null };
  const storage = new TestStorageProvider();
  const svc = new ServerFileTransferService({ bus, storageProvider: storage, ownerAccountId: OWNER });
  await assert.rejects(() => svc.start(), (err) => {
    assert.ok(err.message.includes("sdk"));
    return true;
  });
});

test("ServerFileTransferService.sendFile validates params and sends", async () => {
  const bus = createBus();
  const storage = new TestStorageProvider();
  const deposits = [];
  Object.assign(bus.runtime.sdk, makeSealDispatch({ onSend: (opts) => deposits.push(opts) }));
  const svc = new ServerFileTransferService({ bus, storageProvider: storage, ownerAccountId: OWNER, clock: () => 1000 });
  await svc.start();

  // Small 4-byte PNG-like payload
  const fileDataB64 = "AQIDBA=="; // [1,2,3,4]
  const result = await svc.sendFile({
    threadId: "th_test",
    fileDataB64,
    fileName: "test.png",
    mimeType: "image/png",
  });

  assert.equal(result.threadId, "th_test");
  assert.ok(result.transferId.length > 0);
  assert.ok(result.fileHashHex.length > 0);
  assert.ok(result.messageId.length > 0);
  assert.ok(deposits.length > 0, "should have sent deposits");

  // Verify event was emitted
  const depositedEvents = bus._events.filter((e) => e.eventName === "message.deposited");
  assert.ok(depositedEvents.length > 0, "should emit message.deposited");
});

test("ServerFileTransferService.getFile returns empty for unknown hash", async () => {
  const bus = createBus();
  const storage = new TestStorageProvider();
  const svc = new ServerFileTransferService({ bus, storageProvider: storage, ownerAccountId: OWNER });
  await svc.start();

  const result = await svc.getFile({ fileHashHex: "b".repeat(64) });
  assert.equal(result.fileDataB64, "");
});

test("ServerFileTransferService.handleIncomingPayload returns false before start", async () => {
  const bus = createBus();
  const storage = new TestStorageProvider();
  const svc = new ServerFileTransferService({ bus, storageProvider: storage, ownerAccountId: OWNER });

  const consumed = await svc.handleIncomingPayload({ kind: "rez.file.manifest.v1" }, {});
  assert.equal(consumed, false);
});

test("ServerFileTransferService.handleIncomingPayload delegates to FileTransferService", async () => {
  const bus = createBus();
  const storage = new TestStorageProvider();
  const svc = new ServerFileTransferService({ bus, storageProvider: storage, ownerAccountId: OWNER });
  await svc.start();

  // Non-file payload should not be consumed
  const consumed = await svc.handleIncomingPayload({ kind: "text", text: "hello" }, {});
  assert.equal(consumed, false);
});

// Regression: receive path used to build a plain-object payload and then call
// `.toJSON()` on it, which threw before any persist or event emission. Drive
// the full sender -> receiver round-trip and verify a real ChatImagePayloadV1
// is what reaches the store and the runtime event.
test("ServerFileTransferService receive path persists ChatImagePayloadV1 and emits runtime event", async () => {
  // Sender side
  const senderBus = createBus();
  const senderStorage = new TestStorageProvider();
  const sentDeposits = [];
  Object.assign(senderBus.runtime.sdk, makeSealDispatch({ onSend: (opts) => sentDeposits.push(opts) }));
  const sender = new ServerFileTransferService({
    bus: senderBus, storageProvider: senderStorage, ownerAccountId: OWNER, clock: () => 1000,
  });
  await sender.start();

  // Receiver side — capture upserts and emitted events
  const receiverBus = createBus();
  const receiverStorage = new TestStorageProvider();
  const upsertCalls = [];
  receiverBus.stores.threadStore.upsertDepositedMessage = async (args) => {
    upsertCalls.push(args);
  };
  const receiver = new ServerFileTransferService({
    bus: receiverBus, storageProvider: receiverStorage, ownerAccountId: "rez:acct:test-receiver", clock: () => 2000,
  });
  await receiver.start();

  // Send a small file from sender, capturing both manifest + chunk deposits
  await sender.sendFile({
    threadId: "th_test",
    fileDataB64: "AQIDBA==",
    fileName: "pic.png",
    mimeType: "image/png",
    text: "look at this",
  });
  assert.ok(sentDeposits.length >= 2, "should produce at least manifest + 1 chunk");

  // Route each augmented deposit body into the receiver via handleIncomingPayload.
  // The chat-layer augmentation in onSendDeposit added threadId + senderAccountId
  // alongside the core record fields; lift those out at this boundary the way
  // ServerEventService would.
  for (const deposit of sentDeposits) {
    const body = JSON.parse(new TextDecoder().decode(deposit.plaintextBodyBytes));
    const threadId = typeof body.threadId === "string" ? body.threadId : "";
    const senderAccountId = typeof body.senderAccountId === "string" ? body.senderAccountId : "";
    let record = null;
    if (body.kind === "rez.file.manifest.v1") record = FileManifestV1.fromJSON(body);
    else if (body.kind === "rez.file.chunk.v1") record = FileChunkV1.fromJSON(body);
    else throw new Error("unexpected deposit kind: " + body.kind);
    await receiver.handleIncomingPayload(record, { senderAccountId, threadId });
  }

  // Receiver should have persisted exactly one image message with a real
  // ChatImagePayloadV1 record (not a plain object).
  assert.equal(upsertCalls.length, 1, "expected one upsertDepositedMessage call");
  const persisted = upsertCalls[0];
  assert.ok(persisted.payload instanceof ChatImagePayloadV1,
    "persisted payload must be a ChatImagePayloadV1 instance");
  assert.equal(persisted.payload.fileName, "pic.png");
  assert.equal(persisted.payload.mimeType, "image/png");
  assert.equal(persisted.payload.text, "look at this");
  // The sender side stamped its own ownerAccountId (OWNER) into the augmented
  // wire body; the receiver lifts that out as the message's senderAccountId.
  assert.equal(persisted.senderAccountId, OWNER);
  assert.equal(persisted.threadId, "th_test");

  // runtime.event.message.deposited must be emitted with the same record.
  const runtimeEvents = receiverBus._events.filter((e) => e.eventName === "runtime.event.message.deposited");
  assert.equal(runtimeEvents.length, 1, "expected one runtime.event.message.deposited emission");
  assert.ok(runtimeEvents[0].payload.message.payload instanceof ChatImagePayloadV1,
    "emitted message payload must be a ChatImagePayloadV1 instance");

  // No app.error must have been emitted from the receive path.
  const errors = receiverBus._events.filter((e) => e.eventName === "app.error");
  assert.equal(errors.length, 0, "no app.error should be emitted on the receive path");
});

// Regression: sendFile used to emit message.deposited with status="sent" but
// never persist the "sent" transition to the DB and never fire a
// message.status event. The renderer's _handleStatus is what flips bubbles
// off "SENDING"; without it the sender's own bubble was stuck on "SENDING"
// forever even though the receiver had the image. Mirror the text-message
// flow: deposit "pending", then setMessageStatus + message.status "sent".
test("ServerFileTransferService.sendFile transitions outbound row to sent and emits message.status", async () => {
  const bus = createBus();
  const storage = new TestStorageProvider();
  const statusCalls = [];
  bus.stores.threadStore.setMessageStatus = async (args) => {
    statusCalls.push(args);
  };
  Object.assign(bus.runtime.sdk, makeSealDispatch());
  const svc = new ServerFileTransferService({
    bus, storageProvider: storage, ownerAccountId: OWNER, clock: () => 1000,
  });
  await svc.start();

  const result = await svc.sendFile({
    threadId: "th_test",
    fileDataB64: "AQIDBA==",
    fileName: "test.png",
    mimeType: "image/png",
  });

  const depositedEvents = bus._events.filter((e) => e.eventName === "message.deposited");
  assert.equal(depositedEvents.length, 1, "expected exactly one message.deposited");
  assert.equal(
    depositedEvents[0].payload.message.status,
    "pending",
    "initial deposit must be persisted/announced as pending so DB and event agree",
  );
  assert.equal(depositedEvents[0].payload.message.messageId, result.messageId);
  assert.equal(
    depositedEvents[0].payload.message.senderAccountId,
    OWNER,
    "outbound deposit must credit the owner as sender so the renderer renders it on the mine side",
  );

  const statusEvents = bus._events.filter((e) => e.eventName === "message.status");
  assert.equal(statusEvents.length, 1, "expected exactly one message.status emission");
  assert.equal(statusEvents[0].payload.messageId, result.messageId);
  assert.equal(statusEvents[0].payload.status, "sent");
  assert.equal(statusEvents[0].payload.sentAtMs, 1000);

  assert.equal(statusCalls.length, 1, "setMessageStatus must be invoked for the DB to mirror the event");
  assert.equal(statusCalls[0].messageId, result.messageId);
  assert.equal(statusCalls[0].status, "sent");
  assert.equal(statusCalls[0].sentAtMs, 1000);

  // Ordering: deposit must precede status, so the renderer's _handleStatus
  // finds the row before flipping it.
  const depositedIndex = bus._events.findIndex((e) => e.eventName === "message.deposited");
  const statusIndex = bus._events.findIndex((e) => e.eventName === "message.status");
  assert.ok(depositedIndex < statusIndex, "message.deposited must fire before message.status");
});
