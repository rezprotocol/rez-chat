import test from "node:test";
import assert from "node:assert/strict";

import { PeerLinkCommitErrorV1, PEER_LINK_COMMIT_STAGES } from "@rezprotocol/sdk/peer-link";
import { ServerPeerLinkProtocolService } from "../src/server/services/ServerPeerLinkProtocolService.js";

// DT-007 consumption contract. The SDK returns an owned PeerLinkCommitErrorV1
// on `commitError` when the receive ratchet was verified durable but the
// peer-link transition or lifecycle event could not land. A typed marker that
// nothing reads is useless, so this pins the CONSUMER side: chat must log it
// and raise app.error, and the record must be importable by consumers for
// instanceof / decoding / contract tests.

const OWNER = "rez:acct:ce-owner";
const PEER = "rez:acct:ce-peer";

function frame() {
  const outer = JSON.stringify({ e2ee: 1, v: 1, payload: "opaque" });
  return {
    body: {
      mailboxId: "inbox:ce",
      eventId: "evt_ce_1",
      ciphertextB64: Buffer.from(outer, "utf8").toString("base64"),
    },
  };
}

function makeService({ commitError = null } = {}) {
  const emitted = [];
  const warned = [];
  const bus = { emit(name, payload) { emitted.push({ name, payload }); } };
  const logger = { log() {}, info() {}, error() {}, warn(msg) { warned.push(String(msg)); } };
  const svc = new ServerPeerLinkProtocolService({ bus, ownerAccountId: OWNER, logger });
  const inner = JSON.stringify({ kind: "rez.delivery.ack", senderAccountId: PEER, messageIds: ["mid_ce_1"] });
  svc._peerLinkService = () => ({
    decryptDirectMessageAnyPeer: async () => ({
      plaintextBytes: new TextEncoder().encode(inner),
      encrypted: true,
      snapshot: { peerAccountId: PEER },
      event: null,
      ...(commitError ? { commitError } : {}),
    }),
  });
  svc._noteDeliveryAckReceived = () => {};
  return { svc, emitted, warned };
}

test("the SDK's degraded-commit record is exported for consumers", () => {
  const rec = new PeerLinkCommitErrorV1({ stage: "event-append", message: "boom" });
  assert.ok(rec instanceof PeerLinkCommitErrorV1, "consumers can instanceof the result type");
  assert.equal(rec.code, "PEER_LINK_COMMIT_FAILED");
  assert.equal(typeof rec.toJSON, "function", "owned RRecord, not an ad-hoc object");
  assert.deepEqual(PEER_LINK_COMMIT_STAGES.slice(), ["session-write", "peer-link-transition", "event-append"]);
  // Sealed + validated: an unknown stage is rejected, so the stage string is a
  // contract consumers can switch on rather than a free-form label.
  assert.throws(() => new PeerLinkCommitErrorV1({ stage: "made-up", message: "x" }).validate());
  assert.throws(() => new PeerLinkCommitErrorV1({ stage: "event-append", message: "" }).validate());
});

test("a decrypt carrying commitError is logged AND raised as app.error", async () => {
  const commitError = new PeerLinkCommitErrorV1({ stage: "event-append", message: "append rejected" });
  const { svc, emitted, warned } = makeService({ commitError });

  const result = await svc.processDeposit(frame());

  assert.equal(result.decryptOk, true, "the degraded commit does not fail the decrypt");
  assert.equal(warned.some((m) => m.includes("event-append") && m.includes("append rejected")), true,
    "the failed stage and its cause are logged");
  const errors = emitted.filter((e) => e.name === "app.error");
  assert.equal(errors.length, 1, "exactly one app.error for the degraded commit");
  assert.equal(errors[0].payload.source, "ServerPeerLinkProtocolService");
  assert.equal(errors[0].payload.severity, "warn");
  assert.match(errors[0].payload.message, /commit degraded after decrypt \(event-append\)/);
});

test("a clean decrypt raises no app.error", async () => {
  const { svc, emitted, warned } = makeService();

  const result = await svc.processDeposit(frame());

  assert.equal(result.decryptOk, true);
  assert.equal(emitted.some((e) => e.name === "app.error"), false, "no degraded-commit noise on the happy path");
  assert.equal(warned.some((m) => m.includes("commit degraded")), false);
});
