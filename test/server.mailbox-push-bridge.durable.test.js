// S2 Slice 4 — live-push bridge dual mode. Against a durable node the push bridge
// must NEVER ack-delete (the home log is the system of record); on a consumed push
// it nudges the coalesced catch-up drain to advance the server-held cursor. Against
// a legacy node it keeps ack-deleting the buffer copy and never touches the cursor.

import test from "node:test";
import assert from "node:assert/strict";
import { MailboxPushBridge } from "../src/server/runtime/MailboxPushBridge.js";

const silent = { log() {}, info() {}, warn() {}, error() {} };
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

function makeBus({ submitResult, requestDrainSpy }) {
  return {
    emit() {},
    services: {
      inboundPipeline: { submit() { return Promise.resolve(submitResult); } },
      inboxCatchup: { requestDrain() { requestDrainSpy.push(1); return Promise.resolve(); } },
    },
  };
}

function makeSdk({ durable, ackSpy }) {
  let handler = null;
  return {
    getSessionInfo() { return { capabilities: { durableInbox: durable === true } }; },
    subscriptions: { onMailboxDeposited(h) { handler = h; return () => {}; } },
    mailbox: { async ack(a) { ackSpy.push(a); return {}; } },
    fire(frame) { handler(frame); },
  };
}

test("durable push: a consumed deposit nudges the cursor drain and does NOT ack-delete", async () => {
  const ackSpy = [];
  const requestDrainSpy = [];
  const sdk = makeSdk({ durable: true, ackSpy });
  const bus = makeBus({ submitResult: { consumed: true, decryptOk: true }, requestDrainSpy });
  MailboxPushBridge.attach({ sdk, bus, logger: silent });
  sdk.fire({ body: { mailboxId: "m", seq: 5, ciphertextB64: "x" } });
  await flush();
  assert.deepEqual(ackSpy, [], "durable mode never ack-deletes the buffer copy");
  assert.equal(requestDrainSpy.length, 1, "a consumed push nudges the coalesced cursor drain");
});

test("legacy push: a consumed deposit ack-deletes and does NOT trigger a cursor drain", async () => {
  const ackSpy = [];
  const requestDrainSpy = [];
  const sdk = makeSdk({ durable: false, ackSpy });
  const bus = makeBus({ submitResult: { consumed: true, decryptOk: true }, requestDrainSpy });
  MailboxPushBridge.attach({ sdk, bus, logger: silent });
  sdk.fire({ body: { mailboxId: "m", eventId: "e5", ciphertextB64: "x" } });
  await flush();
  assert.deepEqual(ackSpy, [{ mailboxId: "m", eventId: "e5" }], "legacy mode ack-deletes the consumed deposit");
  assert.equal(requestDrainSpy.length, 0, "no cursor drain in legacy mode");
});

test("durable push: an UNconsumed deposit neither acks nor drains (left for retry)", async () => {
  const ackSpy = [];
  const requestDrainSpy = [];
  const sdk = makeSdk({ durable: true, ackSpy });
  const bus = makeBus({ submitResult: { consumed: false, decryptOk: false }, requestDrainSpy });
  MailboxPushBridge.attach({ sdk, bus, logger: silent });
  sdk.fire({ body: { mailboxId: "m", seq: 9, ciphertextB64: "x" } });
  await flush();
  assert.deepEqual(ackSpy, [], "an undecryptable durable push is not acked");
  assert.equal(requestDrainSpy.length, 0, "an unconsumed durable push does not advance the cursor");
});
