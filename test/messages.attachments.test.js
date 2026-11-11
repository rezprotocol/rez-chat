import { ServerMessagesService } from "../src/server/services/ServerMessagesService.js";
import { ServerFileTransferService } from "../src/server/services/ServerFileTransferService.js";
import { DeviceFanoutCacheStore } from "../src/server/storage/DeviceFanoutCacheStore.js";
import test from "node:test";
import assert from "node:assert/strict";
import { createDefaultStorageProvider, bytesToBase64 } from "@rezprotocol/sdk/client";
import { ChatServerApp } from "../src/server/app/ChatServerApp.js";
import { ChatImagePayloadV1, IMAGE_KIND } from "../src/records/payloads/ChatImagePayloadV1.js";
import { Hash } from "@rezprotocol/sdk/hash";
import { makeSealDispatch } from "./support/sealDispatchDouble.js";
import { InboundDepositPipeline } from "../src/server/runtime/InboundDepositPipeline.js";
import { InboundApplyOutbox } from "../src/server/inbox/InboundApplyOutbox.js";

const ALICE = "rez:acct:alice"; const BOB = "rez:acct:bob";
const params = { threadId: "th_alice", fileDataB64: "AQIDBA==", fileName: "photo.png", mimeType: "image/png", text: "one image", channelId: "photos" };

async function fixture(t, owner, peer, threadId, storage = createDefaultStorageProvider(), clock = 1000) {
  const wire = []; const emitted = [];
  let send = async (body) => { wire.push(body); };
  const sdk = { ...makeSealDispatch({ onSend: async (options) => send(JSON.parse(new TextDecoder().decode(options.plaintextBodyBytes))) }),
    getIdentity: () => ({ localInboxId: "inbox:" + owner }), subscriptions: { onEvent: () => () => {}, onMailboxDeposited: () => () => {} } };
  const app = new ChatServerApp({ ownerAccountId: owner, identity: { accountId: owner, deviceId: "dev:" + owner, publicKeyB64: "p", privateKeyB64: "s" },
    storageProvider: storage, sdk, uplinks: ["ws://fixture"], clock: () => clock,
    logger: { log() {}, warn() {}, error() {}, info() {} } });
  const kv = storage.getKeyValueStore(owner);
  await kv.set("app:threads/" + owner + "/" + threadId, { threadId, threadType: "direct", peerAccountId: peer, peerInboxId: "inbox:" + peer, createdAtMs: 500 });
  app.bus.services.contacts.isActiveContact = async () => true;
  app.on("message.status", (event) => emitted.push(event));
  await app.bus.services.fileTransfer.start();
  t.after(async () => { await app.bus.services.messages.stop(); await app.bus.services.fileTransfer.stop(); await app.bus.services.events.stop(); });
  return { app, wire, emitted, storage, setSend(fn) { send = fn; },
    async rows() { return (await app.bus.services.messages.listMessages({ threadId })).items; } };
}
let sequence = 0;
async function deliver(to, body, authenticatedSender) {
  if (body.kind === "rez.delivery.ack") {
    return to.app.bus.services.events.applyDeliveryAck({ senderAccountId: authenticatedSender, messageIds: body.messageIds });
  }
  return to.app.bus.services.events.applyUserMessage({ eventId: "test:" + (++sequence), mailboxId: "inbox:" + to.app.ownerAccountId,
    plaintextB64: bytesToBase64(new TextEncoder().encode(JSON.stringify(body))), senderAccountId: authenticatedSender });
}

test("image uses the normal message ID/projection/receipt path, including a synchronous early ACK", async (t) => {
  const alice = await fixture(t, ALICE, BOB, "th_alice");
  const bob = await fixture(t, BOB, ALICE, "th_bob");
  const bodies = [];
  alice.setSend(async (body) => { bodies.push(body); await deliver(bob, body, ALICE); });
  bob.setSend((body) => deliver(alice, body, BOB));
  const result = await alice.app.bus.services.messages.sendFile(params);
  assert.equal(bodies.at(-1).kind, IMAGE_KIND);
  assert.equal(bodies.filter((body) => body.kind === IMAGE_KIND).length, 1);
  assert.equal(bodies.at(-1).messageId, result.messageId);
  assert.match(result.messageId, /^local_/, "the same message service mints text and image IDs");
  const a = await alice.rows(); const b = await bob.rows();
  assert.equal(a.length, 1); assert.equal(b.length, 1);
  assert.equal(a[0].messageId, b[0].messageId);
  assert.equal(a[0].status, "delivered", "a late sent write cannot downgrade the early receipt");
  assert.equal(b[0].payload.channelId, "photos");
  assert.equal(b[0].payload.text, "one image");
  assert.equal(alice.emitted.at(-1).status, "delivered", "the UI receives the committed status");
  assert.equal((await bob.app.bus.services.fileTransfer.getFile({ fileHashHex: result.fileHashHex })).fileDataB64, params.fileDataB64);
});

test("offline recipient and sender refresh: durable route resolves the delayed image receipt", async (t) => {
  const alice = await fixture(t, ALICE, BOB, "th_alice");
  const result = await alice.app.bus.services.messages.sendFile(params);
  assert.equal((await alice.rows())[0].status, "sent");
  const restarted = await fixture(t, ALICE, BOB, "th_alice", alice.storage);
  const bob = await fixture(t, BOB, ALICE, "th_bob");
  bob.setSend((body) => deliver(restarted, body, BOB));
  for (const body of alice.wire) await deliver(bob, body, ALICE);
  assert.equal((await restarted.rows())[0].status, "delivered");
  assert.equal((await bob.rows()).length, 1);
  assert.equal((await bob.rows())[0].messageId, result.messageId);
});

test("out-of-order image envelope and receipt outage retry the same message after restart", async (t) => {
  const alice = await fixture(t, ALICE, BOB, "th_alice");
  await alice.app.bus.services.messages.sendFile(params);
  const envelope = alice.wire.at(-1);
  const bob = await fixture(t, BOB, ALICE, "th_bob");
  await assert.rejects(deliver(bob, envelope, ALICE), (error) => error.code === "FILE_BYTES_PENDING");
  assert.equal((await bob.rows()).length, 0, "no image projection or receipt before verified bytes");
  for (const body of alice.wire.slice(0, -1)) await deliver(bob, body, ALICE);
  bob.setSend(async () => { throw new Error("receipt link down"); });
  await assert.rejects(deliver(bob, envelope, ALICE), /receipt link down/);
  const restarted = await fixture(t, BOB, ALICE, "th_bob", bob.storage);
  restarted.setSend((body) => deliver(alice, body, BOB));
  await deliver(restarted, envelope, ALICE);
  await deliver(restarted, envelope, ALICE);
  assert.equal((await restarted.rows()).length, 1, "receipt retries must not create another bubble");
  assert.equal((await alice.rows())[0].status, "delivered");
});

test("old transfer format enters the common apply core with its historical projection ID", async (t) => {
  const alice = await fixture(t, ALICE, BOB, "th_alice");
  await alice.app.bus.services.messages.sendFile(params);
  const bob = await fixture(t, BOB, ALICE, "th_bob");
  for (const body of alice.wire.slice(0, -1)) {
    body.messageEnvelope = false;
    if (body.kind === "rez.file.manifest.v1") body.text = "legacy caption";
    await deliver(bob, body, ALICE);
  }
  const rows = await bob.rows();
  assert.equal(rows.length, 1); assert.equal(rows[0].payload.text, "legacy caption");
  const expected = "img_recv_" + Hash.sha256Hex(JSON.stringify(["rez:chat:received-file-message:v1", ALICE, "th_bob", alice.wire[0].transferId]));
  assert.equal(rows[0].messageId, expected);
  assert.equal(bob.wire.length, 1, "legacy content also uses the common encrypted receipt sender");
});

test("image receipt authentication rejects another peer and never accepts node delivery as receipt", async (t) => {
  const alice = await fixture(t, ALICE, BOB, "th_alice");
  const result = await alice.app.bus.services.messages.sendFile(params);
  await alice.app.bus.services.messages.handleDeliveryAck({ senderAccountId: "rez:acct:mallory", messageIds: [result.messageId] });
  assert.equal((await alice.rows())[0].status, "sent");
  await alice.app.bus.services.messages.handleDeliveryAck({ senderAccountId: BOB, messageIds: [result.messageId] });
  assert.equal((await alice.rows())[0].status, "delivered");
});

test("no image message is created if the byte transfer fails", async (t) => {
  const alice = await fixture(t, ALICE, BOB, "th_alice");
  alice.setSend(async () => { throw new Error("upload interrupted"); });
  await assert.rejects(alice.app.bus.services.messages.sendFile(params), /upload interrupted/);
  assert.equal((await alice.rows()).length, 0);
});

test("a group attachment is delivered to every member without registering expected receipts", async () => {
  class Kv {
    constructor() { this.m = new Map(); }
    get(k) { return this.m.get(k); }
    set(k, v) { this.m.set(k, v); }
    delete(k) { this.m.delete(k); }
    keys(p) { return [...this.m.keys()].filter((k) => k.startsWith(p || "")); }
  }
  const storageProvider = {
    stores: new Map(),
    getKeyValueStore(ns) {
      if (!this.stores.has(ns)) this.stores.set(ns, new Kv());
      return this.stores.get(ns);
    },
  };
  const expectedReceipts = [];
  const sealedFor = [];
  const sdk = {
    getIdentity: () => ({ localInboxId: "inbox:owner" }),
    sealForPeer: async (args) => { sealedFor.push(args.peerAccountId); return { object: {}, address: {} }; },
    sealForPeerDevice: async () => ({ object: {}, address: {} }),
    mesh: { dispatch: async () => ({ queued: false }) },
  };
  const threadStore = {
    async getThread() { return { threadType: "group", groupId: "g1" }; },
    async recordOutboundDeposit() {},
    async setMessageStatus() {},
  };
  const groupStore = {
    async listMembers() {
      return [
        { accountId: "rez:acct:owner", state: "active" },
        { accountId: "rez:acct:m1", state: "active" },
        { accountId: "rez:acct:m2", state: "active" },
      ];
    },
  };
  const threadIndex = { async upsertFromMessage() { return null; } };
  const bus = {
    runtime: { sdk, sessionMode: "claimant" },
    stores: { threadStore, groupStore, threadIndex },
    services: {
      peerLinkProtocol: { recordOutboundGroupMessage: (args) => expectedReceipts.push(args.peerAccountId) },
      threads: { emitThreadIndexUpdated() {}, extractPreviewText() { return "Photo"; } },
    },
    on() { return () => {}; },
    emit() {},
    registerFunction() {},
    call() { return Promise.resolve(null); },
  };
  const quiet = { warn() {}, error() {}, log() {}, info() {} };
  const messages = new ServerMessagesService({
    bus, threadStore, threadIndex, groupStore,
    deviceFanoutStore: new DeviceFanoutCacheStore({ storageProvider }),
    ownerAccountId: "rez:acct:owner",
    logger: quiet,
  });
  bus.services.messages = messages;
  const service = new ServerFileTransferService({ bus, storageProvider, ownerAccountId: "rez:acct:owner", logger: quiet });
  bus.services.fileTransfer = service;
  await service.start();
  const bytes = new Uint8Array(200 * 1024).map((_, i) => i & 255);
  await messages.sendFile({
    threadId: "th_group",
    fileDataB64: Buffer.from(bytes).toString("base64"),
    fileName: "photo.jpg",
    mimeType: "image/jpeg",
  });
  assert.ok(sealedFor.filter((id) => id === "rez:acct:m1").length > 1, "manifest and chunks reach member 1");
  assert.ok(sealedFor.filter((id) => id === "rez:acct:m2").length > 1, "manifest and chunks reach member 2");
  assert.equal(expectedReceipts.length, 2, "only the single image message expects one receipt per member, never its byte chunks");
});

test("durable apply-outbox recovers an image and failed receipt after restart without re-decrypt", async (t) => {
  const alice = await fixture(t, ALICE, BOB, "th_alice");
  await alice.app.bus.services.messages.sendFile(params);
  let decrypts = 0;
  const userMessage = { eventId: "image-outbox", mailboxId: "inbox:bob", senderAccountId: ALICE,
    plaintextB64: bytesToBase64(new TextEncoder().encode(JSON.stringify(alice.wire.at(-1)))) };
  const protocol = { processDeposit: async () => { decrypts++; return { consumed: true, decryptOk: true, userMessage }; } };
  const bob = await fixture(t, BOB, ALICE, "th_bob");
  const makePipeline = (receiver) => {
    const outbox = new InboundApplyOutbox({ kvStore: receiver.storage.getKeyValueStore(null) });
    const pipeline = new InboundDepositPipeline({ peerLinkProtocol: protocol, events: receiver.app.bus.services.events, outbox,
      logger: { log() {}, warn() {}, error() {} } });
    return { pipeline, outbox };
  };
  const first = makePipeline(bob);
  const staged = await first.pipeline.submit({ t: "evt.mailbox.deposited", body: { eventId: userMessage.eventId, mailboxId: userMessage.mailboxId, ciphertextB64: "synthetic-encrypted-frame" } });
  assert.equal(staged.durable, true);
  assert.equal((await first.outbox.listPending(userMessage.mailboxId)).length, 1);
  const secondBob = await fixture(t, BOB, ALICE, "th_bob", bob.storage);
  for (const body of alice.wire.slice(0, -1)) await deliver(secondBob, body, ALICE);
  secondBob.setSend(async () => { throw new Error("receipt connection unavailable"); });
  const second = makePipeline(secondBob);
  await second.pipeline.retryApplyOutbox(userMessage.mailboxId);
  assert.equal((await second.outbox.listPending(userMessage.mailboxId)).length, 1);
  assert.equal((await alice.rows())[0].status, "sent");
  const thirdBob = await fixture(t, BOB, ALICE, "th_bob", bob.storage);
  thirdBob.setSend((body) => deliver(alice, body, BOB));
  const third = makePipeline(thirdBob);
  await third.pipeline.retryApplyOutbox(userMessage.mailboxId);
  assert.equal((await third.outbox.listPending(userMessage.mailboxId)).length, 0);
  assert.equal(decrypts, 1, "recovery reads committed plaintext without advancing the ratchet again");
  assert.equal((await thirdBob.rows()).length, 1);
  assert.equal((await alice.rows())[0].status, "delivered");
});

test("partial image/index projection retries under the original message time before receipt", async (t) => {
  const alice = await fixture(t, ALICE, BOB, "th_alice");
  await alice.app.bus.services.messages.sendFile(params);
  const bob = await fixture(t, BOB, ALICE, "th_bob");
  for (const body of alice.wire.slice(0, -1)) await deliver(bob, body, ALICE);
  bob.app.bus.stores.threadIndex.upsertFromMessage = async () => { throw new Error("index disk full"); };
  await assert.rejects(deliver(bob, alice.wire.at(-1), ALICE), /index disk full/);
  assert.equal(bob.wire.length, 0);
  const restarted = await fixture(t, BOB, ALICE, "th_bob", bob.storage, 9000);
  restarted.setSend((body) => deliver(alice, body, BOB));
  await deliver(restarted, alice.wire.at(-1), ALICE);
  const rows = await restarted.rows();
  assert.equal(rows.length, 1); assert.equal(rows[0].acceptedAtMs, 1000);
  assert.equal((await alice.rows())[0].status, "delivered");
});
