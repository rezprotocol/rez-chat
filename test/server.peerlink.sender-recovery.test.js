// Sender-side recovery (the multi-peer-link group-healing path). An inbound E2EE
// packet is opaque, so a recipient holding more than one peer-link cannot
// attribute an undecryptable group message to a specific link — every idle link
// looks equally guilty, the "exactly one candidate" recipient-side trigger
// refuses to act, and a real group with several contacts never heals.
//
// The SENDER knows exactly who it fanned a message out to. So we re-invite from
// the send side: every outbound group message expects a delivery-ack; a co-member
// whose link is desynced never acks, so its unacked count grows until we re-invite
// THAT peer (exact attribution, no collateral re-key of healthy idle links).
//
// These tests drive the bookkeeping/sweep decision directly (clock injected,
// _triggerRecoveryInvite spied) — no crypto, no real peer-links.

import test from "node:test";
import assert from "node:assert/strict";

import { ServerPeerLinkProtocolService } from "../src/server/services/ServerPeerLinkProtocolService.js";

const SILENT = { log() {}, info() {}, warn() {}, error() {} };
const OWNER = "acct_owner";
const PEER_B = "acct_bob";
const PEER_C = "acct_carol";
const THRESHOLD = 3;
const TIMEOUT_MS = 45_000;

// A service with a controllable clock and _triggerRecoveryInvite captured into
// `triggers` instead of dispatching a real invite (which needs sdk/mesh).
function makeService() {
  let nowMs = 1_000_000;
  const svc = new ServerPeerLinkProtocolService({
    bus: {},
    ownerAccountId: OWNER,
    clock: () => nowMs,
    logger: SILENT,
  });
  const triggers = [];
  svc._triggerRecoveryInvite = (args) => { triggers.push(args); };
  return {
    svc,
    triggers,
    advance(ms) { nowMs += ms; },
  };
}

test("sender recovery: a peer that never acks crosses the threshold and is re-invited", () => {
  const { svc, triggers, advance } = makeService();
  for (let i = 0; i < THRESHOLD; i++) svc.recordOutboundGroupMessage({ peerAccountId: PEER_B });
  // Threshold met but no time has elapsed — not yet stale.
  assert.equal(triggers.length, 0, "no trigger before the timeout elapses");
  advance(TIMEOUT_MS);
  svc._sweepStaleDeliveries();
  assert.equal(triggers.length, 1, "stale peer re-invited once");
  assert.equal(triggers[0].peerAccountId, PEER_B);
});

test("sender recovery: a delivery-ack resets the tally and prevents a re-invite", () => {
  const { svc, triggers, advance } = makeService();
  for (let i = 0; i < THRESHOLD; i++) svc.recordOutboundGroupMessage({ peerAccountId: PEER_B });
  // Bob acks (us->bob proven healthy) — tally clears.
  svc._noteDeliveryAckReceived(PEER_B);
  advance(TIMEOUT_MS + 10_000);
  svc._sweepStaleDeliveries();
  assert.equal(triggers.length, 0, "acked peer is never re-invited");
});

test("sender recovery: below threshold never triggers no matter how much time passes", () => {
  const { svc, triggers, advance } = makeService();
  svc.recordOutboundGroupMessage({ peerAccountId: PEER_B });
  svc.recordOutboundGroupMessage({ peerAccountId: PEER_B });
  advance(TIMEOUT_MS * 10);
  svc._sweepStaleDeliveries();
  assert.equal(triggers.length, 0, "two unacked sends (< threshold) never recover");
});

test("sender recovery: only the desynced peer is re-invited, the acking peer is left alone", () => {
  const { svc, triggers, advance } = makeService();
  for (let i = 0; i < THRESHOLD; i++) {
    svc.recordOutboundGroupMessage({ peerAccountId: PEER_B });
    svc.recordOutboundGroupMessage({ peerAccountId: PEER_C });
  }
  // Carol acks; Bob stays dark.
  svc._noteDeliveryAckReceived(PEER_C);
  advance(TIMEOUT_MS);
  svc._sweepStaleDeliveries();
  assert.equal(triggers.length, 1, "exactly one re-invite");
  assert.equal(triggers[0].peerAccountId, PEER_B, "only the dark peer (Bob) is recovered");
});

test("sender recovery: window resets after a trigger so it doesn't re-fire immediately", () => {
  const { svc, triggers, advance } = makeService();
  for (let i = 0; i < THRESHOLD; i++) svc.recordOutboundGroupMessage({ peerAccountId: PEER_B });
  advance(TIMEOUT_MS);
  svc._sweepStaleDeliveries();
  assert.equal(triggers.length, 1);
  // Immediately sweeping again must NOT re-fire — the window was reset to empty.
  svc._sweepStaleDeliveries();
  assert.equal(triggers.length, 1, "no immediate re-fire");
  // If recovery didn't take, fresh unacked sends rebuild the evidence and retry.
  for (let i = 0; i < THRESHOLD; i++) svc.recordOutboundGroupMessage({ peerAccountId: PEER_B });
  advance(TIMEOUT_MS);
  svc._sweepStaleDeliveries();
  assert.equal(triggers.length, 2, "retries after a fresh window of unacked sends");
});

test("sender recovery: ignores self and empty peer ids", () => {
  const { svc, triggers, advance } = makeService();
  for (let i = 0; i < THRESHOLD + 2; i++) {
    svc.recordOutboundGroupMessage({ peerAccountId: OWNER });
    svc.recordOutboundGroupMessage({ peerAccountId: "" });
    svc.recordOutboundGroupMessage({});
  }
  advance(TIMEOUT_MS * 2);
  svc._sweepStaleDeliveries();
  assert.equal(triggers.length, 0, "self / empty recipients are never tracked");
});

test("sender recovery: recordOutboundGroupMessage sweeps inline so an active sender heals without a separate tick", () => {
  const { svc, triggers, advance } = makeService();
  // Two sends, then time passes, then a third send — the inline sweep on that
  // third record() should fire (threshold met AND timeout elapsed since first).
  svc.recordOutboundGroupMessage({ peerAccountId: PEER_B });
  svc.recordOutboundGroupMessage({ peerAccountId: PEER_B });
  advance(TIMEOUT_MS + 1);
  svc.recordOutboundGroupMessage({ peerAccountId: PEER_B });
  assert.equal(triggers.length, 1, "inline sweep on send re-invites the stale peer");
  assert.equal(triggers[0].peerAccountId, PEER_B);
});
