import test from "node:test";
import assert from "node:assert/strict";

import { ServerPeerLinkProtocolService } from "../src/server/services/ServerPeerLinkProtocolService.js";
import { InboundDepositPipeline } from "../src/server/runtime/InboundDepositPipeline.js";

// DT-002 characterization pins for the control-branch consumption contract
// (DT-006 §4.2/§4.4, corrected in rev 4). These pin what IS, defects
// included:
//
//   1. A decrypted delivery-ack returns `consumed:true` while its durable
//      effect (setMessageStatus via the delivery.ack bus event) rides an
//      UNAWAITED async chain — processDeposit resolves before the effect
//      lands. Crash in that window = the ack is lost with no recovery
//      (DT-008; resolved by DT-302's opaque durable work). When DT-302
//      lands, the first pin below MUST flip: the effect becomes durable
//      before the consumed:true return.
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
      if (name === "delivery.ack") {
        // Model ServerEventService.#handleDeliveryAck: an async handler whose
        // durable write completes strictly later than the emit.
        (async () => {
          await new Promise((r) => setTimeout(r, 20));
          effectDone = true;
        })();
      }
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
    }),
  });
  const acksNoted = [];
  svc._noteDeliveryAckReceived = (sender) => { acksNoted.push(sender); };
  return { svc, emitted, acksNoted, effectLanded: () => effectDone };
}

test("pin (defect, DT-008): delivery-ack returns consumed:true BEFORE its durable effect lands — the crash window exists", async () => {
  const { svc, emitted, acksNoted, effectLanded } = makeAckService();

  const result = await svc.processDeposit(ackFrame());

  assert.equal(result.consumed, true);
  assert.equal(result.decryptOk, true);
  assert.equal("userMessage" in result, false, "control packet yields no userMessage");
  assert.equal(emitted.some((e) => e.name === "delivery.ack"), true, "effect was emitted fire-and-forget");
  assert.deepEqual(acksNoted, [PEER], "recovery evidence cleared for the AUTHENTICATED sender");
  // THE DEFECT: processDeposit already reported consumed (=ack-safe) while
  // the status write has not happened. A crash here loses the ack forever —
  // the ratchet advanced, the deposit gets ack-deleted, the peer never
  // re-sends. DT-302 flips this assertion.
  assert.equal(effectLanded(), false, "consumed:true returned before the durable effect landed (crash window)");

  await new Promise((r) => setTimeout(r, 40));
  assert.equal(effectLanded(), true, "without a crash, the effect does land eventually");
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
