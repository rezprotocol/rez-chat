import test from "node:test";
import assert from "node:assert/strict";

import { ServerPeerLinkProtocolService } from "../src/server/services/ServerPeerLinkProtocolService.js";
import { InboundDepositPipeline } from "../src/server/runtime/InboundDepositPipeline.js";

// DT-302 regression pins for the control-branch consumption contract
// (DT-006 §4.2/§4.4, corrected in rev 4):
//
//   1. The protocol service returns durable opaque work plus a typed ack. The
//      pipeline awaits the app effect and only then marks the work applied.
//   2. The ack's sender authority is the DECRYPT, not the plaintext:
//      a mismatched plaintext senderAccountId is ignored (still consumed).
//   3. The pipeline maps a no-user-message result to `durable = consumed`
//      (InboundDepositPipeline "durable" fallback) — which is exactly what
//      lets catch-up ack-delete the only ciphertext copy of a control
//      packet whose effect may not have landed.

const SILENT = { log() {}, info() {}, warn() {}, error() {} };
const OWNER = "rez:acct:pin-owner";
const PEER = "rez:acct:pin-peer";

function ackFrame() {
  const inner = JSON.stringify({
    kind: "rez.delivery.ack",
    senderAccountId: PEER,
    messageIds: ["mid_pin_1"],
  });
  // Outer envelope shape that routes processDeposit into the E2EE branch.
  const outer = JSON.stringify({ e2ee: 1, v: 1, payload: "opaque" });
  return {
    body: {
      mailboxId: "inbox:pin",
      eventId: "evt_pin_1",
      ciphertextB64: Buffer.from(outer, "utf8").toString("base64"),
    },
    _innerPlaintext: inner,
  };
}

function makeAckService({ plaintextSender = PEER } = {}) {
  const emitted = [];
  let effectDone = false;
  const bus = {
    emit(name, payload) {
      emitted.push({ name, payload });
    },
  };
  const svc = new ServerPeerLinkProtocolService({ bus, ownerAccountId: OWNER, logger: SILENT });
  const inner = JSON.stringify({
    kind: "rez.delivery.ack",
    senderAccountId: plaintextSender,
    messageIds: ["mid_pin_1"],
  });
  svc._peerLinkService = () => ({
    decryptDirectMessageAnyPeer: async () => ({
      plaintextBytes: new TextEncoder().encode(inner),
      encrypted: true,
      snapshot: { peerAccountId: PEER },
      event: null,
      deliveryWork: {
        owner: OWNER,
        sealedDigest: "12".repeat(32),
        plaintextB64: Buffer.from(inner, "utf8").toString("base64"),
        authenticatedSenderAccountId: PEER,
      },
    }),
    markDeliveryWorkApplied: async () => {},
  });
  const acksNoted = [];
  svc._noteDeliveryAckReceived = (sender) => { acksNoted.push(sender); };
  return {
    svc,
    emitted,
    acksNoted,
    effectLanded: () => effectDone,
    applyDeliveryAck: async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      effectDone = true;
    },
  };
}

test("DT-302: delivery-ack application is awaited before the pipeline reports completion", async () => {
  const { svc, emitted, acksNoted, effectLanded, applyDeliveryAck } = makeAckService();
  const pipeline = new InboundDepositPipeline({
    peerLinkProtocol: svc,
    events: {
      applyDeliveryAck,
      applyUserMessage: async () => true,
      processDeposit: async () => ({}),
    },
    logger: SILENT,
  });

  const result = await pipeline.submit(ackFrame());

  assert.equal(result.consumed, true);
  assert.equal(result.decryptOk, true);
  assert.equal(result.applied, true);
  assert.equal(emitted.some((e) => e.name === "delivery.ack"), false, "effect does not use fire-and-forget events");
  assert.deepEqual(acksNoted, [PEER], "recovery evidence cleared for the AUTHENTICATED sender");
  assert.equal(effectLanded(), true, "completion is not reported before the durable effect lands");
});

test("pin: delivery-ack sender authority is the decrypt — mismatched plaintext sender is ignored but still consumed", async () => {
  const { svc, emitted, acksNoted } = makeAckService({ plaintextSender: "rez:acct:mallory" });

  const result = await svc.processDeposit(ackFrame());

  assert.equal(result.consumed, true, "mismatch is still consumed (not retried)");
  assert.equal(result.decryptOk, true);
  assert.equal(emitted.some((e) => e.name === "delivery.ack"), false, "no effect for a spoofed sender");
  assert.deepEqual(acksNoted, [], "spoofed ack clears nobody's recovery state");
});

test("pin: the pipeline maps a no-user-message result to durable=consumed — the ack-delete authorization for control packets", async () => {
  const peerLinkProtocol = {
    processDeposit: async () => ({ consumed: true, decryptOk: true }),
  };
  const events = {
    processDeposit: async () => ({}),
    applyUserMessage: async () => true,
  };
  const pipeline = new InboundDepositPipeline({ peerLinkProtocol, events, logger: SILENT });

  const status = await pipeline.submit({
    body: { mailboxId: "inbox:pin", eventId: "evt_pin_2", ciphertextB64: "aGk=" },
  });

  assert.equal(status.consumed, true);
  assert.equal(status.durable, true,
    "durable falls back to consumed when there is no userMessage — catch-up will ack-DELETE the only ciphertext copy");
});

test("classifier reports malformed JSON without logging decrypted content", () => {
  const warnings = [];
  const svc = new ServerPeerLinkProtocolService({ bus: { emit() {} }, ownerAccountId: OWNER, logger: { ...SILENT, warn: (...args) => warnings.push(args) } });
  const classified = svc.classifyDeliveryWork({ owner: OWNER, sealedDigest: "ab".repeat(32), plaintextB64: Buffer.from("private-invalid-json-secret").toString("base64"), authenticatedSenderAccountId: PEER });
  assert.ok(classified.userMessage);
  assert.equal(warnings.length, 1);
  assert.equal(JSON.stringify(warnings).includes("private-invalid-json-secret"), false);
});
